#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";

const workflow = readFileSync(new URL("../.github/workflows/linear-ticket.yml", import.meta.url), "utf8");
const script = workflow.split("          script: |\n")[1];
assert.ok(script, "Missing inline Linear ticket validator");
const validate = compileFunction(script.replace(/^ {12}/gm, ""), ["context", "core"]);

function run(pr) {
	const messages = [];
	const failures = [];
	validate(
		{ payload: { pull_request: pr } },
		{ info: (message) => messages.push(message), setFailed: (message) => failures.push(message) },
	);
	return { messages, failures };
}

const valid = [
	"ENG-6006",
	"res-1234",
	"fix/eng-6006-bedrock-provider",
	"https://linear.app/primeintellect/issue/ENG-6006/bedrock-requests-fail-because-the-published-cli-is-missing-its",
	"[Research](https://linear.app/primeintellect/issue/RES-1234/research)",
	"https://linear.app/team/issue/ENG-123",
	"https://linear.app/team/issue/res-123?view=details#comment",
];
const invalid = [
	"",
	"Fix Bedrock provider loading",
	"ENG-",
	"ENG-123not-a-ticket",
	"RES-123suffix",
	"ENG-123_suffix",
	"SOMETHING-ENG-",
	"NOTENG-123",
	"https://linear.app/team/issue/ENG-123not-a-ticket",
	"https://linear.app/team/issue/RES-123suffix",
	"https://linear.app/team/issue/ENG-123_suffix",
	"https://linear.app/team/issue/ENG-no-number",
	"https://linear.app/team/issue/OTHER-123",
];
let cases = 0;
for (const field of ["title", "body", "branch"]) {
	for (const [references, expected] of [[valid, true], [invalid, false]]) {
		for (const reference of references) {
			const pr = { title: "Fix provider loading", body: "Validation details", head: { ref: "fix/provider" } };
			if (field === "branch") pr.head.ref = reference;
			else pr[field] = reference;
			const result = run(pr);
			assert.equal(result.failures.length, expected ? 0 : 1, `${field}: ${JSON.stringify(reference)}`);
			assert.deepEqual(result.messages, expected ? ["Linear ticket reference found."] : []);
			cases++;
		}
	}
}

for (const body of [undefined, "No-Ticket:", "No-Ticket:   ", "No-Ticket:\n"]) {
	assert.equal(run({ title: "Fix provider", body, head: { ref: "fix/provider" } }).failures.length, 1);
	cases++;
}
const optOut = run({ title: "Update tooling", body: "No-Ticket: internal maintenance", head: { ref: "chore/tooling" } });
assert.deepEqual(optOut.failures, []);
assert.deepEqual(optOut.messages, ["No-ticket opt-out present: No-Ticket: internal maintenance"]);
cases++;

if (process.argv[2]) {
	const pr = JSON.parse(readFileSync(process.argv[2], "utf8"));
	assert.deepEqual(run({ title: pr.title, body: pr.body, head: { ref: pr.headRefName } }), {
		messages: ["Linear ticket reference found."],
		failures: [],
	});
	cases++;
}
console.log(`Linear ticket check passed (${cases} cases).`);
