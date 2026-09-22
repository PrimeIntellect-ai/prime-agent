#!/usr/bin/env node
/**
 * Resolves the release context for .github/workflows/build-binaries.yml.
 *
 * Besides the version/ref bookkeeping the release workflow has always done, this
 * script decides whether a production publish may run unattended. Production
 * publishing is unattended ONLY when the head commit is the merge commit of a
 * pull request into the default branch that bumped the version and whose CURRENT
 * review state is: at least one human approval of the head commit, no human
 * requesting changes, dismissed approvals ignored. Everything else (direct push,
 * workflow_dispatch, a retry riding an unrelated merge, bot-only or dismissed or
 * stale approvals) is routed to the `release-manual` environment, which has
 * required reviewers.
 *
 * The module exports pure-ish functions so the decision table can be unit tested
 * without a runner; `main()` wires the real git/gh/package.json implementations.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export const PRODUCTION_ENVIRONMENT = "release-r2";
export const MANUAL_ENVIRONMENT = "release-manual";

export class ReleaseContextError extends Error {}

function isHumanReviewer(user) {
	if (!user || typeof user.login !== "string") return false;
	if (user.type && user.type.toLowerCase() === "bot") return false;
	return !user.login.endsWith("[bot]");
}

/** Review states that express an opinion. COMMENTED and PENDING never change a reviewer's verdict. */
const VERDICT_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

function reviewOrder(a, b) {
	const at = Date.parse(a.submitted_at ?? "") || 0;
	const bt = Date.parse(b.submitted_at ?? "") || 0;
	if (at !== bt) return at - bt;
	return (Number(a.id) || 0) - (Number(b.id) || 0);
}

/**
 * Reduces a pull request's review history to the CURRENT verdict of every human
 * reviewer: the latest APPROVED / CHANGES_REQUESTED / DISMISSED review per login.
 * A dismissed approval is not an approval; a later CHANGES_REQUESTED overrides an
 * earlier approval by the same person; COMMENTED reviews carry no verdict.
 *
 * `headSha` is the pull request head: an approval that reviewed an older commit
 * is stale and does not count, so code pushed after the last approval always
 * needs a fresh human look before it can release unattended.
 */
export function evaluateReviews(reviews, headSha) {
	const latest = new Map();
	for (const review of [...reviews].filter((entry) => entry && typeof entry === "object").sort(reviewOrder)) {
		if (!isHumanReviewer(review.user)) continue;
		const state = String(review.state ?? "").toUpperCase();
		if (!VERDICT_STATES.has(state)) continue;
		latest.set(review.user.login, { state, commitId: review.commit_id ?? null });
	}
	const approvers = [];
	const staleApprovers = [];
	const blockers = [];
	for (const [login, verdict] of latest) {
		if (verdict.state === "CHANGES_REQUESTED") blockers.push(login);
		else if (verdict.state === "APPROVED") {
			if (headSha && verdict.commitId === headSha) approvers.push(login);
			else staleApprovers.push(login);
		}
	}
	return { approvers, staleApprovers, blockers };
}

/**
 * Looks for a merged pull request into the default branch whose merge commit is
 * exactly `sha` and whose CURRENT review state is: at least one human approval
 * of the head commit and no human requesting changes.
 */
export function findApprovingPullRequest(deps, repository, sha, defaultBranch) {
	// Any failure to consult GitHub is a reason NOT to publish unattended, never a reason to abort
	// the run: the fail-safe answer is "not approved", which routes production to release-manual and
	// still lets the beta artifacts publish.
	try {
		return findApprovingPullRequestUnsafe(deps, repository, sha, defaultBranch);
	} catch (error) {
		return {
			approved: false,
			reason: `Could not verify pull request approval for ${sha}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function findApprovingPullRequestUnsafe(deps, repository, sha, defaultBranch) {
	const pulls = deps.ghJson(["api", "-H", "Accept: application/vnd.github+json", `repos/${repository}/commits/${sha}/pulls`]);
	if (!Array.isArray(pulls)) {
		return { approved: false, reason: `Could not list pull requests for ${sha}.` };
	}
	const merged = pulls.filter(
		(pull) =>
			pull &&
			typeof pull.number === "number" &&
			typeof pull.merged_at === "string" &&
			pull.merged_at !== "" &&
			pull.merge_commit_sha === sha &&
			pull.base &&
			pull.base.ref === defaultBranch,
	);
	if (merged.length === 0) {
		return { approved: false, reason: `No pull request merged into ${defaultBranch} has ${sha} as its merge commit.` };
	}
	const reasons = [];
	for (const pull of merged) {
		const headSha = pull.head && typeof pull.head.sha === "string" ? pull.head.sha : null;
		if (!headSha) {
			reasons.push(`#${pull.number}: head commit unknown`);
			continue;
		}
		const reviews = deps.ghJson([
			"api",
			"--paginate",
			"--slurp",
			"-H",
			"Accept: application/vnd.github+json",
			`repos/${repository}/pulls/${pull.number}/reviews`,
		]);
		const pages = Array.isArray(reviews) ? reviews : [];
		const flat = pages.every(Array.isArray) ? pages.flat() : pages;
		const { approvers, staleApprovers, blockers } = evaluateReviews(flat, headSha);
		if (blockers.length > 0) {
			reasons.push(`#${pull.number}: changes requested by @${blockers.join(", @")}`);
			continue;
		}
		if (approvers.length > 0) {
			return {
				approved: true,
				reason: `Pull request #${pull.number} is approved at its head commit by @${approvers.join(", @")}.`,
				pullNumber: pull.number,
			};
		}
		if (staleApprovers.length > 0) {
			reasons.push(`#${pull.number}: the approval by @${staleApprovers.join(", @")} predates the head commit ${headSha}`);
		} else {
			reasons.push(`#${pull.number}: no current approving review from a human`);
		}
	}
	return { approved: false, reason: `Merged pull request has no approving review from a human (${reasons.join("; ")}).` };
}

export function resolveReleaseContext(env, deps) {
	const logs = [];
	const log = (message) => logs.push(message);

	const eventName = env.EVENT_NAME;
	const sha = env.GITHUB_SHA_VALUE;
	const repository = env.GITHUB_REPOSITORY;
	const defaultBranch = env.DEFAULT_BRANCH;
	const packageVersion = deps.readPackageVersion();

	let betaVersion = "";
	let buildRef = "";
	let productionVersion = "";
	let publishBeta = false;
	let publishProduction = false;
	let requiresApproval = true;
	let approvalReason = "Production publishing requires a reviewer by default.";

	const betaFor = (version) =>
		`${version}-beta.${env.RUN_NUMBER}.${env.RUN_ATTEMPT}.${String(sha).slice(0, 7)}`;

	if (eventName === "pull_request") {
		// Exercise both packer paths without release credentials or publication.
		productionVersion = packageVersion;
		buildRef = sha;
		betaVersion = betaFor(productionVersion);
		publishBeta = true;
		publishProduction = true;
		requiresApproval = false;
		approvalReason = "Pull request validation never publishes.";
	} else if (eventName === "workflow_dispatch") {
		if (env.REF_NAME !== defaultBranch) {
			throw new ReleaseContextError(
				`Manual releases must run from the default branch (${defaultBranch}), not ${env.REF_NAME}.`,
			);
		}
		productionVersion = String(env.INPUT_RELEASE_TAG || "").replace(/^v/, "");
		if (productionVersion !== packageVersion) {
			throw new ReleaseContextError(
				`Manual release tag v${productionVersion} does not match package.json (${packageVersion}).`,
			);
		}
		buildRef = sha;
		publishProduction = true;
		requiresApproval = true;
		approvalReason = "workflow_dispatch is the break-glass path and always needs a reviewer.";
	} else if (env.REF_TYPE === "tag") {
		throw new ReleaseContextError(
			`Tag pushes no longer release. Tag ${env.REF_NAME} was created outside the release job; delete it or dispatch a manual release.`,
		);
	} else {
		productionVersion = packageVersion;
		buildRef = sha;
		betaVersion = betaFor(productionVersion);
		publishBeta = true;

		let previousVersion = "";
		const beforeSha = env.BEFORE_SHA || "";
		if (beforeSha && !/^0+$/.test(beforeSha) && deps.gitHasPath(beforeSha, "package.json")) {
			previousVersion = deps.readPackageVersionAt(beforeSha);
		}

		const versionChanged = Boolean(previousVersion) && previousVersion !== productionVersion;
		let retry = false;
		if (versionChanged || !previousVersion) {
			if (deps.gitTagExists(`v${productionVersion}`)) {
				const taggedCommit = deps.gitTagCommit(`v${productionVersion}`);
				if (taggedCommit !== sha) {
					throw new ReleaseContextError(
						`Production v${productionVersion} already points to ${taggedCommit}, not ${sha}.`,
					);
				}
				log(`Retrying production v${productionVersion} for ${sha}.`);
			}
			publishProduction = true;
		} else if (!deps.gitTagExists(`v${productionVersion}`)) {
			log(`Production v${productionVersion} has no tag; retrying the failed release.`);
			publishProduction = true;
			retry = true;
		} else {
			log(`Package version is unchanged at ${productionVersion}; only beta will advance.`);
		}

		if (publishProduction) {
			if (retry) {
				requiresApproval = true;
				approvalReason = `${sha} did not bump the version; a retry needs a reviewer.`;
			} else if (productionVersion !== packageVersion) {
				requiresApproval = true;
				approvalReason = `Resolved version ${productionVersion} does not match package.json (${packageVersion}).`;
			} else {
				const verdict = findApprovingPullRequest(deps, repository, sha, defaultBranch);
				requiresApproval = !verdict.approved;
				approvalReason = verdict.reason;
			}
		} else {
			requiresApproval = false;
			approvalReason = "No production publish is scheduled.";
		}
	}

	if (publishProduction && !SEMVER_RE.test(productionVersion)) {
		throw new ReleaseContextError(`Production version must be plain semver like 0.0.1: ${productionVersion}`);
	}

	// Fail safe: anything that is not a verified, approved production release
	// is routed to the environment that has required reviewers.
	const publishEnvironment = publishProduction && !requiresApproval ? PRODUCTION_ENVIRONMENT : MANUAL_ENVIRONMENT;

	log(`Build ref: ${buildRef}`);
	log(`Production: ${publishProduction}${productionVersion ? ` v${productionVersion}` : ""}`);
	log(`Beta: ${publishBeta}${betaVersion ? ` v${betaVersion}` : ""}`);
	log(`Requires approval: ${requiresApproval} (${approvalReason})`);
	log(`Publish environment: ${publishEnvironment}`);

	return {
		outputs: {
			beta_version: betaVersion,
			build_ref: buildRef,
			production_version: productionVersion,
			publish_beta: String(publishBeta),
			publish_production: String(publishProduction),
			requires_approval: String(requiresApproval),
			publish_environment: publishEnvironment,
			approval_reason: approvalReason,
		},
		logs,
	};
}

function realDeps() {
	const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
	const gitOk = (args) => {
		try {
			execFileSync("git", args, { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};
	return {
		readPackageVersion: () => JSON.parse(readFileSync("package.json", "utf8")).version,
		readPackageVersionAt: (ref) => JSON.parse(git(["show", `${ref}:package.json`])).version,
		gitHasPath: (ref, path) => gitOk(["cat-file", "-e", `${ref}:${path}`]),
		gitTagExists: (tag) => gitOk(["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]),
		gitTagCommit: (tag) => git(["rev-list", "-n", "1", tag]),
		ghJson: (args) => {
			const stdout = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
			return JSON.parse(stdout);
		},
	};
}

export function main(env = process.env, deps = realDeps(), write = defaultWrite) {
	const { outputs, logs } = resolveReleaseContext(env, deps);
	for (const line of logs) console.log(line);
	write(env, outputs);
	return outputs;
}

function defaultWrite(env, outputs) {
	if (!env.GITHUB_OUTPUT) return;
	const body = Object.entries(outputs)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
	appendFileSync(env.GITHUB_OUTPUT, `${body}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	try {
		main();
	} catch (error) {
		if (error instanceof ReleaseContextError) {
			console.error(error.message);
			process.exit(1);
		}
		throw error;
	}
}
