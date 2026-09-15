import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	MANUAL_ENVIRONMENT,
	PRODUCTION_ENVIRONMENT,
	ReleaseContextError,
	evaluateReviews,
	findApprovingPullRequest,
	resolveReleaseContext,
} from "../resolve-release-context.mjs";

const SHA = "1111111111111111111111111111111111111111";
const BEFORE = "2222222222222222222222222222222222222222";
const HEAD = "3333333333333333333333333333333333333333"; // the pull request head (last commit before the merge)
const OLDER = "4444444444444444444444444444444444444444"; // an earlier head that a stale approval reviewed

const human = { login: "kevin", type: "User" };
const other = { login: "sam", type: "User" };
const bot = { login: "github-actions[bot]", type: "Bot" };

let reviewId = 0;
/** A review with monotonically increasing id + submitted_at, so order in the array is chronological. */
function review(state, user, overrides = {}) {
	reviewId += 1;
	return {
		id: reviewId,
		state,
		user,
		commit_id: HEAD,
		submitted_at: new Date(Date.UTC(2026, 8, 15, 0, 0, reviewId)).toISOString(),
		...overrides,
	};
}

function mergedPull(number, overrides = {}) {
	return {
		number,
		merged_at: "2026-09-15T00:00:00Z",
		merge_commit_sha: SHA,
		base: { ref: "main" },
		head: { sha: HEAD },
		...overrides,
	};
}

function makeDeps(overrides = {}) {
	const state = {
		packageVersion: "0.9.5",
		previousVersions: { [BEFORE]: "0.9.4" },
		tags: new Set(),
		tagCommits: {},
		pulls: [],
		reviews: {},
		...overrides,
	};
	return {
		state,
		readPackageVersion: () => state.packageVersion,
		readPackageVersionAt: (ref) => state.previousVersions[ref],
		gitHasPath: (ref) => Object.hasOwn(state.previousVersions, ref),
		gitTagExists: (tag) => state.tags.has(tag),
		gitTagCommit: (tag) => state.tagCommits[tag],
		ghJson: (args) => {
			const route = args[args.length - 1];
			if (route.endsWith("/pulls")) return state.pulls;
			const match = route.match(/pulls\/(\d+)\/reviews$/);
			if (match) return state.reviews[match[1]] ?? [];
			throw new Error(`unexpected gh route ${route}`);
		},
	};
}

function pushEnv(overrides = {}) {
	return {
		EVENT_NAME: "push",
		REF_NAME: "main",
		REF_TYPE: "branch",
		DEFAULT_BRANCH: "main",
		GITHUB_SHA_VALUE: SHA,
		GITHUB_REPOSITORY: "PrimeIntellect-ai/prime-agent",
		BEFORE_SHA: BEFORE,
		RUN_NUMBER: "42",
		RUN_ATTEMPT: "1",
		...overrides,
	};
}

test("approved release pull request publishes without a reviewer", () => {
	const deps = makeDeps({
		pulls: [mergedPull(7)],
		reviews: { 7: [review("APPROVED", human)] },
	});
	const { outputs } = resolveReleaseContext(pushEnv(), deps);
	assert.equal(outputs.publish_production, "true");
	assert.equal(outputs.publish_beta, "true");
	assert.equal(outputs.production_version, "0.9.5");
	assert.equal(outputs.requires_approval, "false");
	assert.equal(outputs.publish_environment, PRODUCTION_ENVIRONMENT);
	assert.match(outputs.approval_reason, /#7 is approved at its head commit by @kevin/);
});

/**
 * Current-review-state table. Each row is a review history in chronological
 * order plus the expected verdict. The old implementation accepted ANY historical
 * APPROVED review, so every "manual" row here would have released unattended.
 */
const REVIEW_CASES = [
	{
		name: "a single current human approval releases unattended",
		reviews: () => [review("APPROVED", human)],
		unattended: true,
	},
	{
		name: "approve then dismiss does not count",
		reviews: () => [review("APPROVED", human), review("DISMISSED", human)],
		unattended: false,
		reason: /no current approving review/,
	},
	{
		name: "a review returned by GitHub as DISMISSED (the approval's own state flipped) does not count",
		reviews: () => [review("DISMISSED", human)],
		unattended: false,
	},
	{
		name: "approve then changes requested by another reviewer blocks",
		reviews: () => [review("APPROVED", human), review("CHANGES_REQUESTED", other)],
		unattended: false,
		reason: /changes requested by @sam/,
	},
	{
		name: "changes requested then approve by the same reviewer releases",
		reviews: () => [review("CHANGES_REQUESTED", human), review("APPROVED", human)],
		unattended: true,
	},
	{
		name: "changes requested by one reviewer is not cleared by another reviewer's approval",
		reviews: () => [review("CHANGES_REQUESTED", other), review("APPROVED", human)],
		unattended: false,
		reason: /changes requested by @sam/,
	},
	{
		name: "changes requested, then dismissed, then approved by another reviewer releases",
		reviews: () => [review("CHANGES_REQUESTED", other), review("DISMISSED", other), review("APPROVED", human)],
		unattended: true,
	},
	{
		name: "approve then a later COMMENTED review keeps the approval",
		reviews: () => [review("APPROVED", human), review("COMMENTED", human)],
		unattended: true,
	},
	{
		name: "bot-only approval needs a reviewer",
		reviews: () => [review("APPROVED", bot), review("COMMENTED", human)],
		unattended: false,
		reason: /no current approving review/,
	},
	{
		name: "a bot requesting changes does not block a human approval",
		reviews: () => [review("CHANGES_REQUESTED", bot), review("APPROVED", human)],
		unattended: true,
	},
	{
		name: "only COMMENTED reviews need a reviewer",
		reviews: () => [review("COMMENTED", human), review("COMMENTED", other)],
		unattended: false,
	},
	{
		name: "no reviews at all needs a reviewer",
		reviews: () => [],
		unattended: false,
	},
	{
		name: "an approval that reviewed an older head commit is stale",
		reviews: () => [review("APPROVED", human, { commit_id: OLDER })],
		unattended: false,
		reason: /predates the head commit/,
	},
	{
		name: "a stale approval followed by a fresh one at the head releases",
		reviews: () => [review("APPROVED", human, { commit_id: OLDER }), review("APPROVED", other)],
		unattended: true,
	},
	{
		name: "review order is by submitted_at, not array position",
		reviews: () => {
			const approved = review("APPROVED", human);
			const dismissed = review("DISMISSED", human);
			return [dismissed, approved]; // out of order in the array; the dismissal is later in time
		},
		unattended: false,
	},
	{
		name: "a review with an unknown state neither approves nor blocks",
		reviews: () => [review("SOMETHING_NEW", human), review("APPROVED", other)],
		unattended: true,
	},
];

for (const entry of REVIEW_CASES) {
	test(`review state: ${entry.name}`, () => {
		reviewId = 0;
		const deps = makeDeps({ pulls: [mergedPull(7)], reviews: { 7: entry.reviews() } });
		const { outputs } = resolveReleaseContext(pushEnv(), deps);
		assert.equal(outputs.publish_production, "true");
		assert.equal(outputs.requires_approval, String(!entry.unattended), outputs.approval_reason);
		assert.equal(outputs.publish_environment, entry.unattended ? PRODUCTION_ENVIRONMENT : MANUAL_ENVIRONMENT);
		if (entry.reason) assert.match(outputs.approval_reason, entry.reason);
	});
}

test("evaluateReviews reports approvers, stale approvers and blockers per human", () => {
	reviewId = 0;
	const verdict = evaluateReviews(
		[
			review("APPROVED", { login: "a", type: "User" }, { commit_id: OLDER }),
			review("APPROVED", { login: "b", type: "User" }),
			review("CHANGES_REQUESTED", { login: "c", type: "User" }),
			review("APPROVED", bot),
			null,
			{ state: "APPROVED" }, // no user
		],
		HEAD,
	);
	assert.deepEqual(verdict, { approvers: ["b"], staleApprovers: ["a"], blockers: ["c"] });
	assert.deepEqual(evaluateReviews([review("APPROVED", human)], null), { approvers: [], staleApprovers: ["kevin"], blockers: [] });
});

/** Pull request shape table: the merge itself has to be real and into the default branch. */
const PULL_CASES = [
	{ name: "approval on a pull request whose merge_commit_sha differs", pull: mergedPull(11, { merge_commit_sha: "cafe" }) },
	{ name: "approval on a pull request that is not merged (merged_at null)", pull: mergedPull(11, { merged_at: null }) },
	{ name: "approval on a pull request with an empty merged_at", pull: mergedPull(11, { merged_at: "" }) },
	{ name: "approval on a pull request merged into another branch", pull: mergedPull(11, { base: { ref: "release/next" } }) },
	{ name: "approval on a pull request without base information", pull: mergedPull(11, { base: undefined }) },
	{ name: "approval on a pull request whose head commit is unknown", pull: mergedPull(11, { head: undefined }) },
];

for (const entry of PULL_CASES) {
	test(`pull request shape: ${entry.name} needs a reviewer`, () => {
		reviewId = 0;
		const deps = makeDeps({ pulls: [entry.pull], reviews: { 11: [review("APPROVED", human)] } });
		const { outputs } = resolveReleaseContext(pushEnv(), deps);
		assert.equal(outputs.publish_production, "true");
		assert.equal(outputs.requires_approval, "true", outputs.approval_reason);
		assert.equal(outputs.publish_environment, MANUAL_ENVIRONMENT);
	});
}

test("the merge commit's pull request wins over an unrelated one that merely contains the commit", () => {
	reviewId = 0;
	const deps = makeDeps({
		pulls: [mergedPull(11, { merge_commit_sha: "cafe" }), mergedPull(12)],
		reviews: { 11: [review("CHANGES_REQUESTED", other)], 12: [review("APPROVED", human)] },
	});
	const { outputs } = resolveReleaseContext(pushEnv(), deps);
	assert.equal(outputs.requires_approval, "false");
	assert.match(outputs.approval_reason, /#12/);
});

test("findApprovingPullRequest tolerates paginated (--slurp) review pages and a non-array response", () => {
	reviewId = 0;
	const deps = makeDeps({ pulls: [mergedPull(7)] });
	deps.ghJson = (args) => {
		const route = args[args.length - 1];
		if (route.endsWith("/pulls")) return deps.state.pulls;
		assert.ok(args.includes("--paginate"), "reviews are paginated");
		assert.ok(args.includes("--slurp"), "pages are slurped into one JSON document");
		return [[review("COMMENTED", human)], [review("APPROVED", human)]];
	};
	assert.equal(findApprovingPullRequest(deps, "o/r", SHA, "main").approved, true);
	deps.ghJson = () => ({ message: "Not Found" });
	assert.equal(findApprovingPullRequest(deps, "o/r", SHA, "main").approved, false);
});

test("a GitHub API failure routes production to the manual environment instead of aborting", () => {
	const deps = makeDeps({ pulls: [mergedPull(7)] });
	deps.ghJson = () => {
		throw new Error("gh: HTTP 502 Bad Gateway");
	};
	const verdict = findApprovingPullRequest(deps, "o/r", SHA, "main");
	assert.equal(verdict.approved, false);
	assert.match(verdict.reason, /Could not verify pull request approval/);
	assert.match(verdict.reason, /502/);

	// Through the whole context: the run continues, beta still publishes, production waits.
	const { outputs } = resolveReleaseContext(pushEnv(), deps);
	assert.equal(outputs.publish_production, "true");
	assert.equal(outputs.requires_approval, "true");
	assert.equal(outputs.publish_environment, MANUAL_ENVIRONMENT);
	assert.equal(outputs.publish_beta, "true");
});

test("direct push with no pull request needs a reviewer", () => {
	const deps = makeDeps({ pulls: [] });
	const { outputs } = resolveReleaseContext(pushEnv(), deps);
	assert.equal(outputs.publish_production, "true");
	assert.equal(outputs.requires_approval, "true");
	assert.equal(outputs.publish_environment, MANUAL_ENVIRONMENT);
});

test("retry riding an unrelated approved merge needs a reviewer", () => {
	// The version did not change on this commit; the release is only retried
	// because v0.9.5 has no tag yet.
	reviewId = 0;
	const deps = makeDeps({
		previousVersions: { [BEFORE]: "0.9.5" },
		pulls: [mergedPull(12)],
		reviews: { 12: [review("APPROVED", human)] },
	});
	const { outputs } = resolveReleaseContext(pushEnv(), deps);
	assert.equal(outputs.publish_production, "true");
	assert.equal(outputs.requires_approval, "true");
	assert.match(outputs.approval_reason, /did not bump the version/);
});

test("unchanged version with an existing tag only advances beta", () => {
	const deps = makeDeps({
		previousVersions: { [BEFORE]: "0.9.5" },
		tags: new Set(["v0.9.5"]),
		tagCommits: { "v0.9.5": SHA },
	});
	const { outputs } = resolveReleaseContext(pushEnv(), deps);
	assert.equal(outputs.publish_production, "false");
	assert.equal(outputs.publish_beta, "true");
	assert.equal(outputs.requires_approval, "false");
});

test("a re-run of the release commit keeps its approval", () => {
	reviewId = 0;
	const deps = makeDeps({
		tags: new Set(["v0.9.5"]),
		tagCommits: { "v0.9.5": SHA },
		pulls: [mergedPull(7)],
		reviews: { 7: [review("APPROVED", human)] },
	});
	const { outputs } = resolveReleaseContext(pushEnv({ RUN_ATTEMPT: "2" }), deps);
	assert.equal(outputs.publish_production, "true");
	assert.equal(outputs.requires_approval, "false");
});

test("a version already tagged at another commit is refused", () => {
	const deps = makeDeps({
		tags: new Set(["v0.9.5"]),
		tagCommits: { "v0.9.5": "9999999999999999999999999999999999999999" },
	});
	assert.throws(() => resolveReleaseContext(pushEnv(), deps), ReleaseContextError);
});

test("workflow_dispatch always requires a reviewer", () => {
	const deps = makeDeps();
	const env = pushEnv({ EVENT_NAME: "workflow_dispatch", INPUT_RELEASE_TAG: "v0.9.5" });
	const { outputs } = resolveReleaseContext(env, deps);
	assert.equal(outputs.publish_production, "true");
	assert.equal(outputs.publish_beta, "false");
	assert.equal(outputs.requires_approval, "true");
	assert.equal(outputs.publish_environment, MANUAL_ENVIRONMENT);
});

test("workflow_dispatch refuses a version that is not package.json", () => {
	const deps = makeDeps();
	const env = pushEnv({ EVENT_NAME: "workflow_dispatch", INPUT_RELEASE_TAG: "v9.9.9" });
	assert.throws(() => resolveReleaseContext(env, deps), ReleaseContextError);
});

test("workflow_dispatch refuses a non-default branch", () => {
	const deps = makeDeps();
	const env = pushEnv({ EVENT_NAME: "workflow_dispatch", INPUT_RELEASE_TAG: "v0.9.5", REF_NAME: "feature" });
	assert.throws(() => resolveReleaseContext(env, deps), ReleaseContextError);
});

test("pull requests validate both packers and publish nothing", () => {
	const deps = makeDeps();
	const env = pushEnv({ EVENT_NAME: "pull_request" });
	const { outputs } = resolveReleaseContext(env, deps);
	assert.equal(outputs.publish_production, "true");
	assert.equal(outputs.publish_beta, "true");
	assert.equal(outputs.requires_approval, "false");
	assert.equal(outputs.beta_version, "0.9.5-beta.42.1.1111111");
});

test("a pushed tag no longer releases", () => {
	const deps = makeDeps();
	const env = pushEnv({ REF_TYPE: "tag", REF_NAME: "v0.9.5" });
	assert.throws(() => resolveReleaseContext(env, deps), ReleaseContextError);
});

test("a non-semver production version is refused", () => {
	const deps = makeDeps({ packageVersion: "0.9.5-rc.1" });
	assert.throws(() => resolveReleaseContext(pushEnv(), deps), ReleaseContextError);
});

/**
 * Scratch-repository simulation: runs the real script (real git, real
 * package.json) inside a throwaway repository with a fake `gh` on PATH that
 * serves canned API responses, exactly as the `context` job would.
 */
function scratchRepository() {
	const directory = mkdtempSync(join(tmpdir(), "prime-release-context-"));
	const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: directory };
	const git = (...args) =>
		execFileSync("git", args, { cwd: directory, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	git("config", "commit.gpgsign", "false");
	const commit = (version, message) => {
		writeFileSync(join(directory, "package.json"), `${JSON.stringify({ name: "scratch", version }, null, 2)}\n`);
		git("add", "package.json");
		git("commit", "-q", "-m", message);
		return git("rev-parse", "HEAD");
	};
	return { directory, git, commit };
}

function fakeGh(directory, responses) {
	const bin = join(directory, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(directory, "gh-responses.json"), JSON.stringify(responses));
	const script = join(bin, "gh.mjs");
	writeFileSync(
		script,
		`import { readFileSync } from "node:fs";
const responses = JSON.parse(readFileSync(${JSON.stringify(join(directory, "gh-responses.json"))}, "utf8"));
const route = process.argv[process.argv.length - 1];
for (const [suffix, body] of Object.entries(responses)) {
	if (route.endsWith(suffix)) {
		process.stdout.write(JSON.stringify(body));
		process.exit(0);
	}
}
process.stderr.write("fake gh: unexpected route " + route + "\\n");
process.exit(1);
`,
	);
	const wrapper = join(bin, "gh");
	writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
	chmodSync(wrapper, 0o755);
	return bin;
}

const SCRIPT = resolve(fileURLToPath(import.meta.url), "../../resolve-release-context.mjs");

function runScript(repo, bin, env) {
	const output = join(repo.directory, "github-output");
	writeFileSync(output, "");
	const result = spawnSync(process.execPath, [SCRIPT], {
		cwd: repo.directory,
		encoding: "utf8",
		env: {
			PATH: `${bin}${delimiter}${process.env.PATH}`,
			HOME: repo.directory,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GITHUB_OUTPUT: output,
			GITHUB_REPOSITORY: "o/r",
			DEFAULT_BRANCH: "main",
			EVENT_NAME: "push",
			REF_NAME: "main",
			REF_TYPE: "branch",
			RUN_NUMBER: "1",
			RUN_ATTEMPT: "1",
			...env,
		},
	});
	const outputs = Object.fromEntries(
		readFileSync(output, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const index = line.indexOf("=");
				return [line.slice(0, index), line.slice(index + 1)];
			}),
	);
	return { result, outputs };
}

test("scratch repository: the real script routes a version bump by its current review state", { skip: process.platform === "win32" }, () => {
	const repo = scratchRepository();
	try {
		const before = repo.commit("0.9.4", "previous release");
		const prHead = repo.commit("0.9.5", "bump to 0.9.5"); // stands in for the pull request head
		const mergeSha = prHead; // fast-forward merge: merge_commit_sha is the head commit
		const pull = { number: 7, merged_at: "2026-09-15T00:00:00Z", merge_commit_sha: mergeSha, base: { ref: "main" }, head: { sha: prHead } };
		const human = { login: "kevin", type: "User" };
		const other = { login: "sam", type: "User" };
		const at = (n) => `2026-09-15T00:00:0${n}Z`;
		const scenarios = [
			{
				name: "approved at head",
				reviews: [{ id: 1, state: "APPROVED", user: human, commit_id: prHead, submitted_at: at(1) }],
				environment: PRODUCTION_ENVIRONMENT,
			},
			{
				name: "approved then dismissed",
				reviews: [
					{ id: 1, state: "APPROVED", user: human, commit_id: prHead, submitted_at: at(1) },
					{ id: 2, state: "DISMISSED", user: human, commit_id: prHead, submitted_at: at(2) },
				],
				environment: MANUAL_ENVIRONMENT,
			},
			{
				name: "approved then another reviewer requested changes",
				reviews: [
					{ id: 1, state: "APPROVED", user: human, commit_id: prHead, submitted_at: at(1) },
					{ id: 2, state: "CHANGES_REQUESTED", user: other, commit_id: prHead, submitted_at: at(2) },
				],
				environment: MANUAL_ENVIRONMENT,
			},
			{
				name: "changes requested then approved by the same reviewer",
				reviews: [
					{ id: 1, state: "CHANGES_REQUESTED", user: human, commit_id: prHead, submitted_at: at(1) },
					{ id: 2, state: "APPROVED", user: human, commit_id: prHead, submitted_at: at(2) },
				],
				environment: PRODUCTION_ENVIRONMENT,
			},
			{
				name: "bot-only approval",
				reviews: [{ id: 1, state: "APPROVED", user: { login: "dependabot[bot]", type: "Bot" }, commit_id: prHead, submitted_at: at(1) }],
				environment: MANUAL_ENVIRONMENT,
			},
			{
				name: "stale approval of an older commit",
				reviews: [{ id: 1, state: "APPROVED", user: human, commit_id: before, submitted_at: at(1) }],
				environment: MANUAL_ENVIRONMENT,
			},
		];
		for (const scenario of scenarios) {
			const bin = fakeGh(repo.directory, {
				[`/commits/${mergeSha}/pulls`]: [pull],
				"/pulls/7/reviews": [scenario.reviews],
			});
			const { result, outputs } = runScript(repo, bin, { GITHUB_SHA_VALUE: mergeSha, BEFORE_SHA: before });
			assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}`);
			assert.equal(outputs.publish_production, "true", scenario.name);
			assert.equal(outputs.production_version, "0.9.5", scenario.name);
			assert.equal(outputs.publish_environment, scenario.environment, `${scenario.name}: ${outputs.approval_reason}`);
		}

		// The merge commit of a different pull request: approved, but merge_commit_sha differs.
		const bin = fakeGh(repo.directory, {
			[`/commits/${mergeSha}/pulls`]: [{ ...pull, merge_commit_sha: before }],
			"/pulls/7/reviews": [[{ id: 1, state: "APPROVED", user: human, commit_id: prHead, submitted_at: at(1) }]],
		});
		const { result, outputs } = runScript(repo, bin, { GITHUB_SHA_VALUE: mergeSha, BEFORE_SHA: before });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(outputs.publish_environment, MANUAL_ENVIRONMENT, outputs.approval_reason);
		assert.match(outputs.approval_reason, /No pull request merged into main/);

		// A tag for the version already pointing elsewhere is refused by the real git path.
		repo.git("update-ref", "refs/tags/v0.9.5", before);
		const refused = runScript(repo, bin, { GITHUB_SHA_VALUE: mergeSha, BEFORE_SHA: before });
		assert.equal(refused.result.status, 1);
		assert.match(refused.result.stderr, /already points to/);
	} finally {
		rmSync(repo.directory, { recursive: true, force: true });
	}
});
