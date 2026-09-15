import assert from "node:assert/strict";
import { test } from "node:test";

import {
	binaryOutputRoot,
	parseBuildArgs,
	RELEASE_SIGNER_OVERRIDE_IDENTIFIER,
	releaseSignerDefineArgs,
	validateTestSignerJson,
} from "../../packages/coding-agent/scripts/build-binary.mjs";

const VALID_SIGNER = {
	repositoryUri: "https://github.com/example/prime-agent",
	workflowRepositoryUri: "https://github.com/example/prime-agent",
	workflowPath: ".github/workflows/standalone-binaries.yml",
	oidcIssuer: "https://token.actions.githubusercontent.com",
	runnerEnvironment: "github-hosted",
	refPattern: "^refs/pull/\\d+/merge$",
};

test("a release build always defines the signer override as null", () => {
	assert.deepEqual(releaseSignerDefineArgs(undefined), ["--define", `${RELEASE_SIGNER_OVERRIDE_IDENTIFIER}=null`]);
	assert.equal(RELEASE_SIGNER_OVERRIDE_IDENTIFIER, "__PRIME_AGENT_RELEASE_SIGNER_OVERRIDE__");
});

test("a test signer build defines the override as a JSON string literal that round-trips", () => {
	const text = JSON.stringify(VALID_SIGNER);
	const args = releaseSignerDefineArgs(text);
	assert.equal(args[0], "--define");
	const [identifier, literal] = [args[1].slice(0, args[1].indexOf("=")), args[1].slice(args[1].indexOf("=") + 1)];
	assert.equal(identifier, RELEASE_SIGNER_OVERRIDE_IDENTIFIER);
	// The literal is a JS string literal: evaluating it yields the original document text.
	assert.equal(JSON.parse(literal), text);
	assert.deepEqual(JSON.parse(JSON.parse(literal)), VALID_SIGNER);
});

test("test-only binaries are written next to, never into, the release output directory", () => {
	assert.match(binaryOutputRoot(undefined), /[\\/]packages[\\/]coding-agent[\\/]binaries$/);
	assert.match(binaryOutputRoot("{}"), /[\\/]packages[\\/]coding-agent[\\/]binaries-test-signer$/);
});

test("parses --platform and --test-signer-json in either order and refuses anything else", () => {
	assert.deepEqual(parseBuildArgs(["--platform", "linux-x64", "--test-signer-json", "signer.json"]), {
		platform: "linux-x64",
		testSignerJson: "signer.json",
	});
	assert.deepEqual(parseBuildArgs(["--test-signer-json", "signer.json", "--platform", "all"]), {
		platform: "all",
		testSignerJson: "signer.json",
	});
	assert.equal(parseBuildArgs(["--platform", "darwin-arm64"]).testSignerJson, undefined);
	assert.throws(() => parseBuildArgs(["--platform", "windows-x64"]), /Unsupported binary platform/);
	assert.throws(() => parseBuildArgs(["--test-signer-json"]), /Usage/);
	assert.throws(() => parseBuildArgs(["--signer", "x"]), /Usage/);
	assert.throws(() => parseBuildArgs(["--platform", "linux-x64", "--platform", "all"]), /Usage/);
});

for (const [name, mutate, message] of [
	["missing field", (doc) => delete doc.oidcIssuer, /must set oidcIssuer/],
	["unknown field", (doc) => (doc.extra = "x"), /unknown field extra/],
	["http repository", (doc) => (doc.repositoryUri = "http://github.com/example/prime-agent"), /bare https URL/],
	["credentials in issuer", (doc) => (doc.oidcIssuer = "https://user:pw@token.actions.githubusercontent.com"), /bare https URL/],
	["workflow path without yml", (doc) => (doc.workflowPath = ".github/workflows/build"), /workflowPath/],
	["absolute workflow path", (doc) => (doc.workflowPath = "/.github/workflows/build.yml"), /workflowPath/],
	["unknown runner", (doc) => (doc.runnerEnvironment = "anywhere"), /runnerEnvironment/],
	["unanchored ref pattern", (doc) => (doc.refPattern = "refs/heads/main"), /anchored/],
	["non-compiling ref pattern", (doc) => (doc.refPattern = "^refs/(heads$"), /Invalid regular expression/],
	["non-string field", (doc) => (doc.workflowPath = 7), /non-empty string/],
]) {
	test(`refuses a test signer document with a ${name}`, () => {
		const doc = structuredClone(VALID_SIGNER);
		mutate(doc);
		assert.throws(() => validateTestSignerJson(JSON.stringify(doc)), message);
		assert.throws(() => releaseSignerDefineArgs(JSON.stringify(doc)));
	});
}

test("refuses a test signer document that is not a JSON object", () => {
	assert.throws(() => validateTestSignerJson("not json"), SyntaxError);
	assert.throws(() => validateTestSignerJson("[]"), /JSON object/);
	assert.throws(() => validateTestSignerJson("null"), /JSON object/);
});
