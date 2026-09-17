#!/usr/bin/env node
// Table-driven check for the pre-push guard (scripts/pre-push-guard.sh via the
// .husky/pre-push wrapper), run by `npm run check`. Cases drive the hook with
// pre-push stdin fixtures: "<local ref> <local oid> <remote ref> <remote oid>"
// per line, deletions as "(delete) <zero oid> <remote ref> <remote oid>".
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hook = join(dirname(fileURLToPath(import.meta.url)), "..", ".husky", "pre-push");
const github = "https://github.com/PrimeIntellect-ai/prime-agent.git";
const zero = "0000000000000000000000000000000000000000";
const update = (ref) => `${ref} abc123 ${ref} ${zero}`;
const del = (ref) => `(delete) ${zero} ${ref} abc123`;
const refs = (n) => Array.from({ length: n }, (_, i) => update(`refs/heads/b${i}`)).join("\n");
const mirror = `${refs(12)}\n${del("refs/heads/victim")}`;
const cases = [
	["refuses a mirror push to github", github, mirror, 1],
	["allows a single-branch push to github", github, update("refs/heads/main"), 0],
	["refuses a branch deletion to github", github, del("refs/heads/feature"), 1],
	["refuses a leading-space delete line", github, ` ${del("refs/heads/victim")}`, 1],
	["fails closed on (delete) spelling drift", github, `( delete) ${zero} refs/heads/b abc123`, 1],
	["fails closed on a CRLF delete line", github, `${del("refs/heads/victim")}\r`, 1],
	["allows mirror-like pushes to a file:// remote", "file:///tmp/scratch.git", mirror, 0],
	["the escape hatch allows the mirror push", github, mirror, 0, { PRIME_AGENT_ALLOW_MIRROR_PUSH: "1" }],
	["an empty escape value does not bypass", github, mirror, 1, { PRIME_AGENT_ALLOW_MIRROR_PUSH: "" }],
	["an escape value of 0 does not bypass", github, mirror, 1, { PRIME_AGENT_ALLOW_MIRROR_PUSH: "0" }],
	["an escape value of true does not bypass", github, mirror, 1, { PRIME_AGENT_ALLOW_MIRROR_PUSH: "true" }],
	["refuses a refs/remotes destination", github, update("refs/remotes/origin/main"), 1],
	["allows exactly 10 refs to github", github, refs(10), 0],
	["skips blank lines in the count", github, `\n\n${refs(10)}\n\n`, 0],
	["refuses 11 refs to github", github, refs(11), 1],
	["handles a line without trailing newline", github, update("refs/heads/main"), 0],
	["refuses a mirror push to git@github.com", "git@github.com:PrimeIntellect-ai/prime-agent.git", mirror, 1],
	["refuses an scp URL without a user", "github.com:o/r.git", mirror, 1],
	["refuses a token-userinfo https URL", "https://token@github.com/o/r.git", mirror, 1],
	["refuses an https URL with a port", "https://github.com:443/o/r.git", mirror, 1],
	["refuses ssh://github.com:22 without a user", "ssh://github.com:22/o/r.git", mirror, 1],
	["refuses ssh://git@github.com:22", "ssh://git@github.com:22/o/r.git", mirror, 1],
	["refuses git@ssh.github.com", "git@ssh.github.com:o/r.git", mirror, 1],
	["allows a lookalike phishing host", "https://github.com.evil.com/o/r.git", mirror, 0],
	["allows an ssh alias remote", "git@gh:o/r.git", mirror, 0],
	["refuses an http://github.com URL", "http://github.com/o/r.git", mirror, 1],
	["refuses a www.github.com URL", "https://www.github.com/o/r.git", mirror, 1],
	["refuses a trailing-dot host", "https://github.com./o/r.git", mirror, 1],
	["refuses a trailing-dot scp host", "git@github.com.:o/r.git", mirror, 1],
	["fails closed on malformed stdin", github, "refs/heads/main refs/heads/main", 1],
	["allows an empty up-to-date push", github, "", 0],
];

let failures = 0;
for (const [name, url, input, code, env] of cases) {
	const result = spawnSync("sh", [hook, "origin", url], {
		input,
		encoding: "utf8",
		timeout: 9000,
		env: { ...process.env, PRIME_AGENT_ALLOW_MIRROR_PUSH: "", ...env },
	});
	const stderr = result.stderr ?? "";
	const refusedWell =
		stderr.includes("refusing push to") &&
		stderr.includes("deleted 62 remote branches and auto-closed 63 PRs on 2026-09-17") &&
		stderr.includes("PRIME_AGENT_ALLOW_MIRROR_PUSH=1 git push origin ...");
	if (result.status !== code || (code === 1 && !refusedWell)) {
		failures += 1;
		console.error(`FAIL ${name}: exit=${result.status} expected=${code}`);
		console.error(stderr);
	}
}
if (failures > 0) {
	console.error(`pre-push guard check: ${failures} failing case(s)`);
	process.exit(1);
}
console.log(`pre-push guard check: ${cases.length} cases passed.`);
