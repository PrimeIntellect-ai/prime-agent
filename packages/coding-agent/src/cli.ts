#!/usr/bin/env node
// The Node 22+ module graph fails at link time on older Node, so it must load
// behind the dynamic import, after the dependency-free guard runs.
import { assertNodeVersion } from "./cli/node-version-check.js";

const supported = process.versions.bun
	? true
	: assertNodeVersion({
			version: process.versions.node,
			log: console.error,
			exit: (code) => process.exit(code),
		});

if (supported) {
	const { runCli } = await import("./cli-main.js");
	await runCli();
}
