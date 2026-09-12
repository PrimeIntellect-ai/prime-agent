#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [packageJson, ...extra] = process.argv.slice(2);
const canonicalSemver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function fail(message) {
	console.error(`Invalid package.json version: ${message}`);
	process.exit(1);
}

if (!packageJson || extra.length !== 0) fail("expected exactly one package.json path");

let packageData;
try {
	packageData = JSON.parse(readFileSync(packageJson, "utf8"));
} catch (error) {
	fail(error.message);
}

if (!Object.hasOwn(packageData, "version") || typeof packageData.version !== "string") {
	fail("version must be a string");
}

// This closed grammar accepts only canonical SemVer core versions. In particular,
// it rejects CR/LF and every prerelease/build/injection suffix before the value can
// participate in shell interpolation or a GITHUB_OUTPUT record.
if (!canonicalSemver.test(packageData.version)) {
	fail("version must be one canonical plain semver (for example 0.7.1)");
}

process.stdout.write(`${packageData.version}\n`);
