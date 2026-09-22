#!/usr/bin/env node
/**
 * Release pipeline invariants.
 *
 * These are the properties that make the release safe to run with 45 people
 * holding write access. They are cheap to break by accident in a YAML edit, so
 * they are asserted in CI instead of in a review checklist.
 *
 * The central one: no job holds both a credential and repository code. A job is
 * credential-bearing when it runs in an environment, holds a write permission
 * (a contents:write GITHUB_TOKEN can push tags; id-token:write mints OIDC
 * tokens) or references any secret other than exactly `secrets.GITHUB_TOKEN`
 * anywhere in an expression. Such a job may not check the repository out,
 * install dependencies, or execute anything that lives in the checkout -
 * through any interpreter, not just `node scripts/...`. Because the checker
 * reads shell statically, constructs whose effect it cannot prove (`sh -c`,
 * `eval`, `xargs`, `env -S`, piping into a shell, a command substitution that
 * names a script) are forbidden outright in those jobs, and every command such
 * a job runs must be on an explicit allowlist (ALLOWED_COMMANDS): coreutils,
 * jq, gh, cosign, tar, curl and the one tool the job exists to run. No
 * interpreter, no wrapper, no path. Every aws call must go to the R2 endpoint
 * the secret names, and only plainly spelled downloaded-artifact paths may be
 * uploaded - or named at all: a `..` segment anywhere in such a job is an error.
 *
 * The environment requirement is derived the same way: every credential-bearing
 * job must declare `environment:` unless it is one of the three jobs whose
 * credential the checker proves inert without one (ENVIRONMENT_EXEMPT_JOBS), and
 * every job holding contents:write must sit in the publication order.
 *
 * Every allowlisted tool is read through an option table (review round 7): an
 * option the table does not name is an error, a word that begins with an
 * expansion may stand only where the table proves it is a value (or where the
 * variable's value provably begins with a literal), and every variable a step
 * expands must be on ALLOWED_VARIABLES and bound in that step.
 */

import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "yaml";

const WORKFLOW_DIRECTORY = ".github/workflows";
const RELEASE_WORKFLOW = ".github/workflows/build-binaries.yml";
const STANDALONE_WORKFLOW = ".github/workflows/standalone-binaries.yml";
const BUILD_WORKFLOWS = [RELEASE_WORKFLOW, STANDALONE_WORKFLOW];
/** Where the updater pins the release signer; the checker proves the standalone job cannot mint that identity. */
const RELEASE_TRUST_SOURCE = "packages/coding-agent/src/utils/release-trust.ts";
const SHA_PIN = /@[0-9a-f]{40}$/;

/** Jobs that must exist and hold their deployment credential in a protected environment. */
export const CREDENTIAL_JOBS = ["publish-r2", "finalize-release", "publish-beta-r2", "publish-npm", "tap-bump"];
/**
 * Every credential-bearing job - derived from its permissions, secrets and environment, never from
 * a list - must declare `environment:` (review round 6, finding 1). A contents:write GITHUB_TOKEN
 * outside an environment could publish a release or push a tag before verify ran. The three jobs
 * below are the only ones allowed to hold a credential without an environment, each because of a
 * property the checker proves every run; a new credential-bearing job is an error until it names
 * an environment.
 *   - sign: holds only OIDC minting (id-token/attestations) and no secret; the identity it can mint
 *     names this workflow at the run's ref, and verify, publish-beta-r2 and the updater all pin
 *     the default branch or a v* tag, so a signature from any other ref is worthless.
 *   - github-release: contents:write only; every `gh release create|edit` is a draft (a draft
 *     creates no tag and is invisible), `gh api` never writes, git is never run.
 *   - github-release-beta: contents:write only; it needs publish-beta-r2, which runs in the beta
 *     environment, so the environment's rules gate it transitively.
 */
export const ENVIRONMENT_EXEMPT_JOBS = {
	sign: { permissions: { attestations: "write", contents: "read", "id-token": "write" }, proof: "oidc-only" },
	"github-release": { permissions: { contents: "write" }, proof: "draft-only" },
	"github-release-beta": { permissions: { contents: "write" }, proof: "gated-by", gate: "publish-beta-r2" },
};
/** The jobs that may hold `contents: write`; any other job that does must `needs: verify` (review round 6, finding 1). */
export const CONTENTS_WRITE_JOBS = ["github-release", "finalize-release", "github-release-beta"];
const VERIFY_JOB = "verify";
/** Jobs that must exist so the ordering invariants below have something to hold on to. */
const ORDERED_JOBS = ["github-release", "publish-r2", "verify", "finalize-release"];
/** The only job allowed to move a production channel pointer. */
const POINTER_JOB = "finalize-release";
/** The production channel pointers, in the order finalize-release writes them. */
export const PRODUCTION_POINTERS = ["latest.json", "stable", "install.sh", "install-beta.sh"];
/**
 * The only jobs that may invoke the aws CLI at all, and the only R2 keys each may write to.
 *
 * Every `aws s3 cp` destination in these jobs must be spelled out in the workflow file:
 * `s3://${R2_BUCKET}/releases/v${<prefix>}/<literal>` or `.../${name}` where `name` is the
 * basename of the `for file in artifacts/*` loop variable, or - in the job's LAST step only - one
 * of the listed pointer keys. Any other variable, command substitution, bucket or prefix is an
 * error, so `key=stable; aws s3 cp x "s3://$B/$key"` can never sneak a pointer write past the
 * publication order. `aws s3 mv|sync|rm`, `--recursive` and every writing `s3api` call are errors.
 */
export const R2_WRITERS = {
	"publish-r2": { prefix: "PRODUCTION_VERSION", pointers: [] },
	"publish-beta-r2": { prefix: "BETA_VERSION", pointers: ["beta", "beta.json"] },
	[POINTER_JOB]: { prefix: null, pointers: PRODUCTION_POINTERS },
};
/**
 * Options an aws invocation in a publish job may carry, per operation, with the number of values
 * each consumes. Every invocation must carry `--endpoint-url "$R2_ENDPOINT_URL"` - the variable
 * bound from the secret at step level - exactly once; `--region` may only say `auto` (or
 * `"$AWS_DEFAULT_REGION"`, which the step env pins to `auto`). Anything else (`--profile`,
 * `--no-verify-ssl`, `--ca-bundle`, `--endpoint-url=<value>`, another region or endpoint) is an
 * error (review round 5, finding 2).
 */
const AWS_OPTIONS = {
	"s3 cp": { "--endpoint-url": 1, "--region": 1, "--content-type": 1, "--cache-control": 1, "--quiet": 0, "--no-progress": 0, "--only-show-errors": 0 },
	"s3 ls": { "--endpoint-url": 1, "--region": 1 },
	s3api: { "--endpoint-url": 1, "--region": 1, "--bucket": 1, "--key": 1, "--prefix": 1 },
};
const AWS_ENDPOINT_VALUE = /^\$\{?R2_ENDPOINT_URL\}?$/;
const AWS_REGION_VALUE = /^(auto|\$\{?AWS_DEFAULT_REGION\}?)$/;
/** `aws s3api` operations that only read. */
const AWS_S3API_READS = /^(head-object|head-bucket|get-object|list-objects|list-objects-v2)$/;
/** Variables the R2 destinations are built from; a publish step may not reassign them. */
const R2_PROTECTED_VARIABLES = /^(R2_BUCKET|R2_ENDPOINT_URL|PRODUCTION_VERSION|BETA_VERSION|AWS_DEFAULT_REGION)$/;
/** How the R2 destination variables must reach a publish job. */
const R2_ENV_SOURCES = {
	R2_BUCKET: /^\$\{\{\s*secrets\.(NIGHTLY_)?R2_BUCKET\s*\}\}$/,
	R2_ENDPOINT_URL: /^\$\{\{\s*secrets\.(NIGHTLY_)?R2_ENDPOINT_URL\s*\}\}$/,
	PRODUCTION_VERSION: /^\$\{\{\s*needs\.context\.outputs\.production_version\s*\}\}$/,
	BETA_VERSION: /^\$\{\{\s*needs\.context\.outputs\.beta_version\s*\}\}$/,
	AWS_DEFAULT_REGION: /^auto$/,
};
/** A relative path under a downloaded artifact directory, spelled plainly: no `.`/`..`/empty segment, no `~`, no leading `/`, no glob. */
export function isArtifactPath(text, artifactDirectories) {
	if (typeof text !== "string" || text === "" || text.startsWith("/") || text.startsWith("~") || /[*?[$`{}]/.test(text)) return false;
	const segments = text.split("/");
	if (segments.length < 2 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
	const normalized = posix.normalize(text);
	if (normalized !== text) return false;
	return artifactDirectories.some((directory) => normalized.startsWith(`${directory}/`) && normalized.length > directory.length + 1);
}
/** A literal object name: no expansion, no slash, no leading dot. */
const LITERAL_OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Builtins that change the working directory; in a credential-bearing job only `cd`/`pushd` into a downloaded artifact directory is allowed. */
const DIRECTORY_COMMANDS = /^(cd|pushd|popd|chdir)$/;
/** Commands that assign the names given as their arguments. */
const ASSIGNING_COMMANDS = /^(read|local|declare|typeset|export|readonly|mapfile|readarray|let|unset|getopts|printf)$/;
/** The only `shell:` a credential-bearing step may declare: the checker reads bash. */
const PLAIN_SHELL = /^(bash|sh)$/;

/**
 * The shell variables a credential-bearing step may expand in an argument or a redirection target
 * (review round 7, finding 3). An allowlist over names: a variable the checker does not know is an
 * error until it is named here, and every name must be bound in the step - declared in the job's
 * or step's `env:`, set by the runner ({@link GITHUB_DEFAULT_ENV}) or assigned earlier in the block
 * by an assignment, `for`, `read`, `local`, `declare` or `export` - because an unbound name would
 * take whatever the environment holds. The step's own credentials (`GH_TOKEN`,
 * `AWS_SECRET_ACCESS_KEY`, ...) are deliberately absent: the tools read them from the
 * environment, and a step that spelled one could write it into a file the job uploads.
 */
export const ALLOWED_VARIABLES = [
	// Bound from the context job's outputs or the workflow's env.
	"PRODUCTION_VERSION", "BETA_VERSION", "BUILD_REF", "DEFAULT_BRANCH", "TAP_REPO", "R2_BUCKET", "R2_ENDPOINT_URL",
	// Bound in the publish and finalize steps.
	"file", "name", "digest", "local_digest", "existing_digest", "readback_digest", "count", "pointer", "prefix", "key", "head_status", "type", "expected", "actual",
	// Bound in the release steps.
	"TAG", "tag", "ref", "sha", "tagged", "release_id", "missing", "failed", "asset_id", "latest_main_sha", "newest", "newer",
	// Bound in the npm publish step.
	"names", "tarball", "path",
	// Bound in the tap bump step.
	"branch", "workdir", "default_branch", "lease", "formula", "version_pattern", "platform", "rewritten", "previous", "digests", "line", "rest", "title", "body", "existing",
	// Bound in the sign step.
	"archive",
];
/** Variables the runner sets in every job; never an option, never attacker-chosen. */
export const GITHUB_DEFAULT_ENV = ["GITHUB_REPOSITORY", "GITHUB_OUTPUT", "GITHUB_WORKSPACE", "GITHUB_REF", "GITHUB_REF_NAME", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SERVER_URL", "GITHUB_API_URL", "RUNNER_TEMP", "RUNNER_OS", "RUNNER_ARCH"];
/** `$GITHUB_ENV` and `$GITHUB_PATH` set the environment and PATH of every later step: writing to them is code loading by another name. */
const STEP_STATE_FILES = /GITHUB_(ENV|PATH)\b/;
/**
 * Commands whose options cannot write a file or run a program, so an argument that turns out to be
 * an option is at worst a wrong answer: an expanded word may stand in any argument position of
 * these. Every other command - the publishing tools, the writing coreutils (`cp --target-directory`,
 * `sort -o`, `tee -a`, `rm -r`), `set` (`set +e`, `set -a`), the assigning builtins - gets an
 * expanded word only in the value slot of a known option, after a literal `--`, or when the
 * variable's value provably begins with a literal that is not `-` (review round 7, finding 3).
 */
const EXPANSION_SAFE_COMMANDS = /^(basename|cat|cmp|cut|date|diff|dirname|echo|false|grep|head|ls|pwd|sha256sum|sleep|tail|test|tr|true|uniq|wc|\[|:|exit|return|continue|break|shift|wait)$/;
/**
 * Coreutils that can create, move or delete files (`sort -o`, `mktemp` included): the options each
 * may carry, literal and value-less, and whether its positionals are files it writes (`targets`:
 * the last one for cp/mv, all of them for rm/mkdir/tee/..., none for sort/mktemp). None may write
 * into a downloaded artifact directory.
 */
const WRITING_COREUTILS = {
	cp: { options: /^-[rRpaf]+$/, targets: "last" },
	mv: { options: /^-f$/, targets: "last" },
	rm: { options: /^-[rf]+$/, targets: "all" },
	mkdir: { options: /^-p$/, targets: "all" },
	rmdir: { options: /^-p$/, targets: "all" },
	chmod: { options: /^-R$/, targets: "all" },
	tee: { options: /^-a$/, targets: "all" },
	touch: { options: /^$/, targets: "all" },
	sort: { options: /^-[urn]+$/, targets: "none" },
	mktemp: { options: /^(-d|--directory)$/, targets: "none" },
};
/** Tools whose whole argument list is parsed against a table: an option not in the table is an error. */
const TOOL_OPTIONS = {
	jq: { "-r": 0, "--raw-output": 0, "-e": 0, "--exit-status": 0, "-c": 0, "--compact-output": 0, "-s": 0, "--slurp": 0, "-n": 0, "--null-input": 0, "-S": 0, "--sort-keys": 0, "-j": 0, "--join-output": 0, "-a": 0, "--ascii-output": 0, "--tab": 0, "--indent": 1, "--arg": 2, "--argjson": 2, "--args": 0, "--jsonargs": 0 },
	cosign: {
		"sign-blob": { "--yes": 0, "-y": 0, "--bundle": 1 },
		"verify-blob": { "--bundle": 1, "--certificate-identity": 1, "--certificate-oidc-issuer": 1 },
	},
	syft: { scan: { "-o": 1, "--output": 1, "-q": 0, "--quiet": 0 } },
	tar: { "-x": 0, "--extract": 0, "-t": 0, "--list": 0, "-z": 0, "--gzip": 0, "-j": 0, "-J": 0, "-v": 0, "--verbose": 0, "-f": 1, "--file": 1, "-C": 1, "--directory": 1, "--strip-components": 1 },
	curl: { "--proto": 1, "-f": 0, "--fail": 0, "-s": 0, "--silent": 0, "-S": 0, "--show-error": 0, "-L": 0, "--location": 0, "--retry": 1, "--retry-delay": 1, "--max-time": 1, "-m": 1, "--connect-timeout": 1, "-o": 1, "--output": 1, "-I": 0, "--head": 0 },
	"gh api": { "--jq": 1, "-q": 1, "--paginate": 0, "--method": 1, "-X": 1, "-f": 1, "--raw-field": 1, "-F": 1, "--field": 1, "--input": 1, "--silent": 0, "--slurp": 0 },
	"gh pr": {
		list: { "--repo": 1, "-R": 1, "--head": 1, "-H": 1, "--base": 1, "-B": 1, "--state": 1, "-s": 1, "--json": 1, "--jq": 1, "-q": 1, "--limit": 1, "-L": 1, "--author": 1, "-A": 1, "--label": 1, "-l": 1, "--search": 1, "-S": 1 },
		create: { "--repo": 1, "-R": 1, "--head": 1, "-H": 1, "--base": 1, "-B": 1, "--title": 1, "-t": 1, "--body": 1, "-b": 1, "--body-file": 1, "-F": 1, "--draft": 0, "-d": 0, "--label": 1, "-l": 1, "--reviewer": 1, "-r": 1, "--assignee": 1, "-a": 1 },
		edit: { "--repo": 1, "-R": 1, "--title": 1, "-t": 1, "--body": 1, "-b": 1, "--body-file": 1, "-F": 1, "--base": 1, "-B": 1, "--add-label": 1, "--remove-label": 1 },
		view: { "--repo": 1, "-R": 1, "--json": 1, "--jq": 1, "-q": 1, "--comments": 0, "-c": 0 },
	},
};
/** `git` subcommands a credential-bearing job may run and the options each takes (`-c` is `switch --create`, never a config). */
const GIT_COMMAND_OPTIONS = {
	"symbolic-ref": { "--short": 0, "-q": 0, "--quiet": 0 },
	"ls-remote": { "--heads": 0, "-h": 0, "--tags": 0, "-t": 0, "--refs": 0, "-q": 0, "--quiet": 0, "--exit-code": 0 },
	switch: { "-c": 1, "--create": 1, "--detach": 0, "-q": 0, "--quiet": 0 },
	diff: { "--quiet": 0, "--exit-code": 0, "--stat": 0, "--name-only": 0, "--cached": 0, "--staged": 0 },
	commit: { "-a": 0, "--all": 0, "-m": 1, "--message": 1, "-q": 0, "--quiet": 0 },
	push: { "--force-with-lease": 0, "--atomic": 0, "-q": 0, "--quiet": 0, "--porcelain": 0, "--dry-run": 0, "-n": 0 },
	status: { "--porcelain": 0, "-s": 0, "--short": 0, "-b": 0, "--branch": 0 },
	"rev-parse": { "--verify": 0, "--short": 0, "--abbrev-ref": 0, "-q": 0, "--quiet": 0, "--is-inside-work-tree": 0, "--show-toplevel": 0 },
};
/** The one `npm` line a credential-bearing job may run, besides `npm --version`: the tarball is the only free word. */
const NPM_PUBLISH_OPTIONS = ["--provenance", "--access", "public", "--ignore-scripts"];
/** pflag spellings of `true`; any other value after `--draft=` or `--latest=` is read as its opposite or an error, both of which publish or fail. */
const PFLAG_TRUE = /^(1|t|T|TRUE|true|True)$/;

/**
 * Parses an argument list against a table of known options (`{ "--name": valueCount }`). A long
 * option may attach its value with `=`; a one-value short option may attach it (`-XPOST`); zero-
 * value short options may cluster (`-fsSL`), with a one-value letter last (`-xzf FILE`). A literal
 * `--` ends option parsing. Parsing begins at `start` (the words before it are the subcommand).
 * Returns the options seen, the indices of the words consumed as values, the positional indices,
 * the words the table does not know, and the index of the first word after `--` (-1 when there is
 * none). An option whose name is built from an expansion is unknown.
 */
export function parseOptions(args, table, start = 0) {
	const options = [];
	const values = new Set();
	const positionals = [];
	const unknown = [];
	let rest = -1;
	for (let index = start; index < args.length; index += 1) {
		const arg = args[index];
		const text = arg.text;
		if (rest !== -1 || !text.startsWith("-") || text === "-") {
			positionals.push(index);
			continue;
		}
		if (text === "--" && !arg.expansion) {
			rest = index + 1;
			continue;
		}
		const [name, ...attachedParts] = text.split("=");
		if (arg.expansion && /[$`]/.test(name)) {
			unknown.push(arg);
			continue;
		}
		const attached = attachedParts.length > 0 ? attachedParts.join("=") : null;
		if (name.startsWith("--")) {
			const count = table[name];
			if (count === undefined) {
				unknown.push(arg);
				continue;
			}
			if (attached !== null) options.push({ name, value: { text: attached, expansion: arg.expansion }, index, attached: true });
			else {
				options.push({ name, value: count === 1 ? args[index + 1] : undefined, index, attached: false });
				for (let n = 1; n <= count; n += 1) values.add(index + n);
				index += count;
			}
			continue;
		}
		// Short options: `-X POST`, `-XPOST`, `-fsSL`, `-xzf FILE`, `-d=false`.
		const letters = name.slice(1);
		let consumedNext = 0;
		let known = true;
		for (let position = 0; position < letters.length; position += 1) {
			const short = `-${letters[position]}`;
			const count = table[short];
			if (count === undefined) {
				known = false;
				break;
			}
			if (count === 0) {
				options.push({ name: short, value: attached !== null && position === letters.length - 1 ? { text: attached, expansion: arg.expansion } : undefined, index, attached: attached !== null && position === letters.length - 1 });
				continue;
			}
			// A letter that takes a value: the rest of the cluster (or the next word) is that value.
			const remainder = letters.slice(position + 1);
			if (remainder.length > 0 || attached !== null) {
				const value = remainder.length > 0 ? `${remainder}${attached !== null ? `=${attached}` : ""}` : attached;
				options.push({ name: short, value: { text: value, expansion: arg.expansion }, index, attached: true });
			} else {
				options.push({ name: short, value: args[index + 1], index, attached: false });
				consumedNext = count;
			}
			break;
		}
		if (!known) {
			unknown.push(arg);
			continue;
		}
		for (let n = 1; n <= consumedNext; n += 1) values.add(index + n);
		index += consumedNext;
	}
	return { options, values, positionals, unknown, rest };
}

/**
 * An arithmetic body with its command and process substitutions blanked out: their words belong to
 * commands the substitution walks inspect as commands, not to the arithmetic's variable references
 * (review round 8, finding 3 - `x=$(( $(basename "$file") ))` was read as expanding `$basename`).
 */
function maskedSubstitutions(body) {
	let masked = "";
	let i = 0;
	while (i < body.length) {
		const ch = body[i];
		if (ch === "`") {
			const close = body.indexOf("`", i + 1);
			const end = close === -1 ? body.length : close + 1;
			masked += " ".repeat(end - i);
			i = end;
			continue;
		}
		if ((ch === "$" || ch === "<" || ch === ">") && body[i + 1] === "(") {
			let depth = 1;
			let j = i + 2;
			while (j < body.length && depth > 0) {
				if (body[j] === "(") depth += 1;
				else if (body[j] === ")") depth -= 1;
				j += 1;
			}
			masked += " ".repeat(j - i);
			i = j;
			continue;
		}
		masked += ch;
		i += 1;
	}
	return masked;
}

/**
 * The variable names a word references, and the reasons it expands something the checker cannot
 * follow: an indirect expansion (`${!x}`), a transformation (`${x@P}` runs prompt expansion, which
 * runs commands), an assignment inside `$(( ))`. Command substitutions are skipped here: their
 * commands are inspected on their own.
 */
export function variableReferences(text) {
	const names = [];
	const reasons = [];
	const source = String(text);
	const skipParens = (start, depth) => {
		let j = start;
		let open = depth;
		while (j < source.length && open > 0) {
			if (source[j] === "(") open += 1;
			else if (source[j] === ")") open -= 1;
			j += 1;
		}
		return j;
	};
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (ch === "`") {
			const close = source.indexOf("`", i + 1);
			i = close === -1 ? source.length : close + 1;
			continue;
		}
		if (ch !== "$") {
			i += 1;
			continue;
		}
		const next = source[i + 1];
		if (next === "(") {
			if (source[i + 2] === "(") {
				const end = skipParens(i + 3, 2);
				const body = source.slice(i + 3, Math.max(i + 3, end - 2));
				if (/(^|[^=!<>])=(?!=)|\+\+|--/.test(body)) reasons.push(`assigns a variable inside an arithmetic expansion: $((${body}))`);
				for (const match of maskedSubstitutions(body).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) names.push(match[0]);
				i = end;
			} else i = skipParens(i + 2, 1);
			continue;
		}
		if (next === "{") {
			let depth = 1;
			let j = i + 2;
			while (j < source.length && depth > 0) {
				if (source[j] === "{") depth += 1;
				else if (source[j] === "}") depth -= 1;
				j += 1;
			}
			const body = source.slice(i + 2, depth === 0 ? j - 1 : j);
			i = j;
			if (body.startsWith("!")) {
				reasons.push(`\${${body}} is an indirect expansion: the variable it names cannot be known statically`);
				continue;
			}
			const match = body.match(/^#?([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!0-])/);
			if (!match) {
				reasons.push(`\${${body}} is an expansion the checker cannot read`);
				continue;
			}
			if (/^[A-Za-z_]/.test(match[1])) names.push(match[1]);
			const remainder = body.slice(match[0].length);
			if (/^(\[[^\]]*\])?@/.test(remainder)) {
				reasons.push(`\${${body}} applies a transformation (@P expands a prompt string, which runs commands)`);
				continue;
			}
			const inner = variableReferences(remainder);
			names.push(...inner.names);
			reasons.push(...inner.reasons);
			continue;
		}
		const match = source.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!0-])/);
		if (match) {
			if (/^[A-Za-z_]/.test(match[1])) names.push(match[1]);
			i += 1 + match[1].length;
			continue;
		}
		i += 1;
	}
	return { names, reasons };
}

/** The variable a word begins with (`$x`, `${x:-y}`), or null when it begins with a literal or a command substitution. */
function leadingVariable(text) {
	const match = String(text).match(/^\$(?:\{#?([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/);
	return match ? (match[1] ?? match[2]) : null;
}

/** True when the word's value provably begins with something that is not `-`: a literal, or a variable known to (see {@link EXPANSION_SAFE_COMMANDS}). */
function beginsSafely(text, prefixed) {
	if (text === "" || text.startsWith("-") || text.startsWith("`") || text.startsWith("$(")) return false;
	if (!text.startsWith("$")) return true;
	const name = leadingVariable(text);
	return name !== null && prefixed.has(name);
}

/**
 * The only place a binary may be compiled with a test signer override, and the only step that may
 * do it: the standalone job's end-to-end updater test against an archive this very job signs.
 * The test binary never leaves $RUNNER_TEMP; the uploaded `standalone-<platform>` artifact must
 * not include it.
 */
export const TEST_SIGNER_FLAG = "--test-signer-json";
export const TEST_SIGNER_STEP = { workflow: STANDALONE_WORKFLOW, job: "build", step: "Compile a test-signer binary for the updater test" };
export const TEST_SIGNER_DIRECTORIES = ["binaries-test-signer", "test-release"];

/**
 * The only actions a credential-bearing job may `uses:`. An allowlist, not a denylist: a
 * SHA-pinned third-party action is still code that runs next to the credential, so every one a
 * job needs is named here, per job. `*` applies to every credential-bearing job.
 *   - publish-npm needs setup-node for npm >= 11.5.1 (OIDC trusted publishing).
 *   - sign holds id-token:write and attestations:write and needs cosign, syft and the provenance action.
 * `actions/github-script` is not used anywhere in the release and is therefore not allowed.
 */
export const ALLOWED_ACTIONS = {
	"*": [/^actions\/download-artifact@/, /^actions\/upload-artifact@/],
	"publish-npm": [/^actions\/setup-node@/],
	sign: [/^sigstore\/cosign-installer@/, /^anchore\/sbom-action\/download-syft@/, /^actions\/attest-build-provenance@/],
	"publish-beta-r2": [/^sigstore\/cosign-installer@/],
};

/**
 * The beta signature contract (review round 5, finding 4). A compiled beta install verifies
 * `SHA256SUMS.sigstore.json` next to `SHA256SUMS` with the identity the updater pins - this
 * workflow file at the default branch - so the sign job must run for the beta too, publish-beta-r2
 * must download the bundle into the directory it uploads from, verify it against that identity
 * before the credential is used, and never skip it in the upload loop.
 */
export const BETA_SIGNATURES = {
	artifact: "release-beta-signatures",
	artifactsArtifact: "release-final-beta",
	bundle: "SHA256SUMS.sigstore.json",
	signJob: "sign",
	publishJob: "publish-beta-r2",
	uploadStep: "Upload immutable beta objects",
	identity: 'https://github.com/${GITHUB_REPOSITORY}/.github/workflows/build-binaries.yml@refs/heads/${DEFAULT_BRANCH}',
	issuer: "https://token.actions.githubusercontent.com",
	defaultBranch: "${{ github.event.repository.default_branch }}",
};

/**
 * The only commands a credential-bearing job may run (review round 5, finding 1). An allowlist over
 * bare command names looked up on PATH: no interpreter of any kind (not even `node -e` with code
 * written in the workflow file - `node -e "require('./scr'+'ipts/x')"` reads the checkout without
 * ever spelling `scripts/`), no wrapper (`env`, `sudo`, `timeout`, `exec`, ...), no path. `*`
 * applies to every credential-bearing job; the per-job entries name the one tool that job exists
 * to run. Shell functions defined in the same `run` block may be called; defining one whose name is
 * on the allowlist (shadowing `aws`, `test`, ...) is an error.
 */
const COREUTILS = ["basename", "cat", "chmod", "cmp", "cp", "cut", "date", "diff", "dirname", "echo", "false", "head", "ls", "mkdir", "mktemp", "mv", "printf", "pwd", "rm", "rmdir", "sha256sum", "sleep", "sort", "tail", "tee", "test", "touch", "tr", "true", "uniq", "wc"];
const SHELL_BUILTINS = ["set", "exit", "return", "continue", "break", "shift", "local", "read", "unset", "export", "declare", "readonly", ":", "[", "wait"];
export const ALLOWED_COMMANDS = {
	"*": [...COREUTILS, ...SHELL_BUILTINS, "grep", "jq", "tar", "curl", "gh"],
	"publish-r2": ["aws"],
	"publish-beta-r2": ["aws", "cosign"],
	"finalize-release": ["aws"],
	sign: ["cosign", "syft"],
	"publish-npm": ["npm"],
	// No sed: its `e`, `w`, `r`, `W`, `R` commands and `s///e` flag run programs and write files. The
	// formula bump is written with parameter expansion (review round 7, finding 1).
	"tap-bump": ["git"],
};
/** `gh` subcommands a credential-bearing job may use; `gh extension`, `gh alias --shell`, `gh config`, `gh run download -D` and friends run code or move files. */
const GH_SUBCOMMANDS = /^(api|release|pr|repo)$/;
/**
 * `gh release` subcommands a credential-bearing job may use and the options each takes, with the
 * number of values each consumes. Options that name a file to read are listed in
 * {@link GH_FILE_OPTIONS}. Anything not listed is an error: the checker has to know which words
 * are the release assets to check where they come from (review round 6, finding 3).
 */
const GH_RELEASE_OPTIONS = {
	create: { "--draft": 0, "-d": 0, "--prerelease": 0, "-p": 0, "--latest": 0, "--verify-tag": 0, "--generate-notes": 0, "--notes-from-tag": 0, "--fail-on-no-commits": 0, "--title": 1, "-t": 1, "--target": 1, "--notes": 1, "-n": 1, "--notes-file": 1, "-F": 1, "--notes-start-tag": 1, "--discussion-category": 1, "--repo": 1, "-R": 1 },
	edit: { "--draft": 0, "--prerelease": 0, "--latest": 0, "--verify-tag": 0, "--title": 1, "-t": 1, "--target": 1, "--notes": 1, "-n": 1, "--notes-file": 1, "-F": 1, "--tag": 1, "--discussion-category": 1, "--repo": 1, "-R": 1 },
	upload: { "--clobber": 0, "--repo": 1, "-R": 1 },
	view: { "--json": 1, "--jq": 1, "-q": 1, "--template": 1, "-t": 1, "--repo": 1, "-R": 1 },
	// Reading the published assets back on a re-run: read-only on GitHub, and the
	// --dir target must be a downloaded-artifact directory (checked in releaseReasons).
	download: { "--dir": 1, "-D": 1, "--clobber": 0, "--pattern": 1, "-p": 1, "--skip-existing": 0, "--repo": 1, "-R": 1 },
	list: { "--json": 1, "--jq": 1, "-q": 1, "--template": 1, "-t": 1, "--repo": 1, "-R": 1, "--limit": 1, "-L": 1, "--exclude-drafts": 0, "--exclude-pre-releases": 0, "--order": 1, "-O": 1 },
};
/** `gh` options whose value is a file the command reads and sends; the file must be a downloaded artifact or a literal under /tmp. */
const GH_FILE_OPTIONS = /^(--notes-file|-F|--body-file|--input)$/;
/** `gh api --method|-X`, `-f`, `-F`, `--field`, `--raw-field`, `--input` turn a read into a write; attached spellings (`-XPOST`, `--method=POST`) are read through {@link parseOptions}. */
const GH_API_WRITE_OPTIONS = /^(--method|-X|-f|--raw-field|-F|--field|--input)$/;
/**
 * True when a `gh api` argument list writes, or carries anything the checker cannot read (an
 * unknown option, an option built from an expansion): only a plainly spelled read is a read.
 */
export function ghApiWrites(args) {
	const parsed = parseOptions(args, TOOL_OPTIONS["gh api"], 1);
	return parsed.unknown.length > 0 || parsed.options.some((option) => GH_API_WRITE_OPTIONS.test(option.name));
}
/**
 * Reads the draft flags of a `gh release create|edit` argument list with the option table, so an
 * option VALUE spelled `--draft` (`--title --draft`) does not count and every spelling of a
 * publishing flag does (review round 7b, finding A). Returns `{ draft, publishes, unknown }`:
 * `draft` when a real `--draft`/`-d` flag is present and not set false, `publishes` when
 * `--draft=<anything but a pflag true>`, `--latest` or `--latest=<pflag true>` appears, `unknown`
 * when an option is not in the table (the checker then cannot tell flags from assets).
 */
export function ghReleaseDraftFlags(args) {
	const operation = args[1] && !args[1].expansion ? args[1].text : "";
	const table = GH_RELEASE_OPTIONS[operation];
	if (!table) return { draft: false, publishes: true, unknown: true };
	const parsed = parseOptions(args, table, 2);
	let draft = false;
	let publishes = false;
	for (const option of parsed.options) {
		if (option.name === "--draft" || option.name === "-d") {
			if (option.value === undefined) draft = true;
			else if (!option.value.expansion && PFLAG_TRUE.test(option.value.text)) draft = true;
			else {
				draft = false;
				publishes = true;
			}
		}
		if (option.name === "--latest" && (option.value === undefined || option.value.expansion || PFLAG_TRUE.test(option.value.text))) publishes = true;
	}
	return { draft, publishes, unknown: parsed.unknown.length > 0 };
}
/** A file the job itself wrote under /tmp, spelled literally. */
const TMP_FILE = /^\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * A `..` segment anywhere, a `.` segment inside a path, or a `./` prefix - after a `=`, `:` or `@`
 * too (`--field body=@../x`). Only plainly spelled paths may name a file in a credential-bearing
 * job (review round 6, finding 3). `${var//pattern/repl}` bodies are not paths and are skipped.
 */
const DOT_SEGMENT = /(^|[\/=:@])\.\.(\/|$)|\/\.(\/|$)|(^|[=:@])\.\//;
const PATTERN_SUBSTITUTION = /\$\{[A-Za-z_][A-Za-z0-9_]*\/[^}]*\}/g;
export function hasDotSegment(text) {
	if (String(text).includes("://")) return false; // a URL
	return DOT_SEGMENT.test(String(text).replace(PATTERN_SUBSTITUTION, "X"));
}
/** After `gh repo clone <repo> <dir> --`, only a shallow-clone depth may be handed to git. */
const GH_CLONE_GIT_OPTIONS = /^--depth$/;
/** `git` global options a credential-bearing job may use: `-C <dir>` and the two identity keys `-c user.name=`/`-c user.email=`. */
const GIT_CONFIG_KEYS = /^user\.(name|email)=/;
const GIT_SUBCOMMANDS = /^(symbolic-ref|ls-remote|switch|diff|commit|push|status|rev-parse)$/;
/** git options that name a program to run (locally for a local remote, or as the remote helper) or another config. */
const GIT_FORBIDDEN_OPTIONS = /^(--upload-pack|--receive-pack|--exec|--ext-diff|--config|--config-env|--exec-path|--git-dir|--work-tree|--namespace|-u|--no-verify|--template|--recurse-submodules|--hooks?-path)(=|$)/;
/** tar options that run a program. */
const TAR_FORBIDDEN_OPTIONS = /^(--to-command|--use-compress-program|-I|--checkpoint-action|--rmt-command|--rsh-command|--info-script|--new-volume-script|-F|--files-from|-T|--occurrence)(=|$)/;
/** curl in a credential-bearing job must pin `--proto '=https'` and may not read a config file, disable TLS checks or name an http:// URL. */
const CURL_FORBIDDEN_OPTIONS = /^(-K|--config|-k|--insecure|--proto-default|--proto-redir|--cacert|--capath|--ssl-no-revoke|--netrc|-n|--netrc-file|--netrc-optional|-x|--proxy|--preproxy|--noproxy|--unix-socket|--abstract-unix-socket|--resolve|--connect-to|--doh-url|-O|--remote-name|-J|--remote-header-name|--output-dir)(=|$)/;
/**
 * Environment variables that redirect where a credential is sent or which configuration a tool
 * loads: an aws endpoint or profile override, a gh host, git's every knob (`GIT_SSH_COMMAND`,
 * `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_*`), npm config, the TLS trust roots, `HOME`. None may be set in a
 * credential-bearing job, in `env:` or in the shell (review round 5, finding 2).
 */
const CREDENTIAL_ENV = /^(AWS_ENDPOINT_URL(_[A-Z0-9_]+)?|AWS_PROFILE|AWS_REGION|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|AWS_CA_BUNDLE|AWS_DATA_PATH|AWS_IGNORE_CONFIGURED_ENDPOINT_URLS|AWS_USE_FIPS_ENDPOINT|AWS_USE_DUALSTACK_ENDPOINT|AWS_STS_REGIONAL_ENDPOINTS|AWS_SDK_LOAD_CONFIG|AWS_EC2_METADATA_SERVICE_ENDPOINT|AWS_CONTAINER_CREDENTIALS_FULL_URI|AWS_CONTAINER_CREDENTIALS_RELATIVE_URI|AWS_WEB_IDENTITY_TOKEN_FILE|AWS_ROLE_ARN|GH_HOST|GH_CONFIG_DIR|GH_PATH|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_BROWSER|GH_EDITOR|GH_PAGER|GIT_[A-Z0-9_]+|NPM_CONFIG_[A-Z0-9_]+|npm_config_[A-Za-z0-9_]+|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_HOME|CURL_CA_BUNDLE|XDG_CONFIG_HOME|HOME|COSIGN_[A-Z0-9_]+|SIGSTORE_[A-Z0-9_]+|TUF_ROOT|HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy)$/;
/** File paths a credential-bearing step may never name: the dotfiles the allowlisted tools read their configuration and credentials from. */
const CONFIGURATION_PATH = /^~(\/|$)|^[A-Za-z_][A-Za-z0-9_]*=~(\/|$)|(^|[\/"'=:])\$\{?HOME\}?(\/|$)|(^|\/)\.(aws|npmrc|gitconfig|git-credentials|config\/gh|config\/git|config\/npm|bashrc|bash_profile|profile|zshrc|curlrc|netrc|sigstore|docker)(\/|$)/;

const PACKAGE_MANAGERS = /^(npm|npx|yarn|pnpm|bun|bunx|corepack|uv|uvx|pip|pip3)$/;
const SHELLS = /^(bash|sh|zsh|dash|ksh|ash|fish)$/;
const INTERPRETERS = /^(node|nodejs|bash|sh|zsh|dash|ksh|ash|fish|python|python3|perl|ruby|tsx|ts-node|deno)$/;
/**
 * The inline-code flags of each interpreter, and version/help. {@link repositoryCodeReasons} uses
 * them to say precisely what an interpreter line would do (`--import`, `--require`, `-r`,
 * `--loader`, `--env-file`, `--run`, `-m`, `-I`, ... load code the checker cannot see). In a
 * credential-bearing job no interpreter may run at all, inline code included - see
 * {@link ALLOWED_COMMANDS} (review round 5, finding 1) - so these only sharpen the diagnostic.
 */
const INLINE_CODE_FLAGS = {
	node: /^(-e|--eval|-p|--print)$/,
	nodejs: /^(-e|--eval|-p|--print)$/,
	tsx: /^(-e|--eval|-p|--print)$/,
	"ts-node": /^(-e|--eval|-p|--print)$/,
	python: /^-c$/,
	python3: /^-c$/,
	perl: /^-[eE]$/,
	ruby: /^-e$/,
};
const INTERPRETER_INFO_FLAGS = /^(--version|-v|-V|--help|-h)$/;
/**
 * Package-manager invocations that run dependency lifecycle scripts (install-time code from the
 * registry) and are therefore refused on every build runner unless `--ignore-scripts` is enabled.
 * `npm rebuild` exists to run an install script, so it is never useful with `--ignore-scripts`;
 * the single allowed form is the literal `npm rebuild esbuild` in the jobs listed in REBUILD_JOBS.
 */
const LIFECYCLE_SUBCOMMANDS = {
	npm: /^(ci|install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|install-clean|clean-install|ic|cit|install-test|it|update|up|upgrade|udpate|dedupe|ddp|find-dupes|prune|rebuild|rb|link|ln|exec|x|audit|restart)$/,
	yarn: /^(|install|add|up|upgrade|upgrade-interactive|dedupe|dlx|import|link|rebuild)$/,
	pnpm: /^(install|i|add|update|up|upgrade|rebuild|rb|dlx|exec|link|prune|dedupe|import|deploy)$/,
	bun: /^(install|i|add|update|remove|rm|link|x|pm|create|c)$/,
	uv: /^(pip|sync|add|remove|tool|run)$/,
};
/** Package managers that always install and run code with no lifecycle switch the checker trusts. */
const ALWAYS_LIFECYCLE = /^(bunx|uvx|pip|pip3)$/;
/**
 * Tools that run another command after their own options - `corepack npm ci`, `npx --yes npm ci`,
 * `volta run npm ci`, `nvm exec 20 npm ci`, `fnm exec --using=20 npm ci`, `asdf exec npm ci`,
 * `mise x node@20 -- npm ci`, `pnpm dlx`, `yarn dlx`. The child is held to the lifecycle rules as
 * if it had been written directly (review round 7b, finding D). corepack's own subcommands only
 * download a package manager; a version manager with no recognisable child is refused outright.
 */
const PACKAGE_EXECUTORS = /^(corepack|npx|volta|nvm|fnm|asdf|mise)$/;
const COREPACK_SUBCOMMANDS = /^(enable|disable|prepare|hydrate|up|use|install|pack|cache|--version|-v|--help|-h)$/;
export const REBUILD_ALLOWLIST = { command: ["npm", "rebuild", "esbuild"], jobs: { [RELEASE_WORKFLOW]: ["build", "validate-macos", "pack-npm"], [STANDALONE_WORKFLOW]: ["build"] } };
/** `if:` conditions that run a job or step after an upstream failure or cancellation. Nothing in the release may use one. */
const STATUS_FUNCTIONS = /\b(always|failure|cancelled|success)\s*\(/;
/** Every job that calls the standalone workflow must hold exactly these permissions and pass nothing else. */
const STANDALONE_CALLER_PERMISSIONS = { contents: "read", "id-token": "write" };
/** The one job in the release workflow that may call a reusable workflow. */
const STANDALONE_CALLER_JOB = "standalone";
const STANDALONE_CALLER_INPUTS = ["build_ref"];
/**
 * The immutable-upload guard. `aws s3api head-object` fails for many reasons (a revoked token, a
 * network error, a wrong endpoint); only an explicit 404 from the service proves the key is absent.
 * Anything else must stop the release instead of uploading over an object it could not see.
 * The exact lines are asserted so a loosened guard is a checker failure, not a review nit.
 */
export const HEAD_OBJECT_GUARD = {
	reset: "head_status=0",
	capture: "head_status=$?",
	errorFile: "/tmp/head.err",
	exists: 'if [ "$head_status" -eq 0 ]; then',
	absent: `elif [ "$head_status" -eq 254 ] && grep -qE '^An error occurred \\((404|NotFound|NoSuchKey)\\) when calling the HeadObject operation' /tmp/head.err; then`,
};
const SOURCE_COMMANDS = /^(source|\.)$/;
/** Commands whose effect the static checker cannot follow; forbidden outright in credential-bearing jobs. */
const OPAQUE_EXECUTORS = /^(eval|xargs|parallel)$/;
/** Builtins that change how later command names resolve or run code the checker cannot see (`trap 'node x' EXIT`). */
const RESOLUTION_BUILTINS = /^(alias|unalias|shopt|enable|hash|trap)$/;
/**
 * Environment and shell variables that make a shell or interpreter load or run code the checker
 * cannot see, or change how a name or path resolves: a startup file (`BASH_ENV`, `ENV`), a
 * preload (`LD_PRELOAD`, `NODE_OPTIONS`), a prompt or trace string that is expanded - and with
 * `set -x` executed - before every command (`PROMPT_COMMAND`, `PS0`-`PS4`), `CDPATH` (where `cd
 * artifacts` really goes), `GLOBIGNORE` (which files `artifacts/*` names), `EXECIGNORE`,
 * `BASH_LOADABLES_PATH`, `BASH_XTRACEFD`, `SHELL`. None may be set in a credential-bearing job -
 * in `env:`, as a plain assignment, through `export`/`declare`/`local`/`readonly`/`read`/`printf -v`
 * or as a prefix to a wrapper (review round 6, finding 7).
 */
const STARTUP_ENV = /^(BASH_ENV|ENV|PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|PS[0-4]|CDPATH|GLOBIGNORE|EXECIGNORE|BASH_LOADABLES_PATH|BASH_XTRACEFD|SHELL)$/;
/** `declare -n`/`local -n`/`typeset -n` create a name reference: a later assignment to the reference sets whatever variable it names. */
const NAMEREF_COMMANDS = /^(declare|local|typeset)$/;
/** Words that may precede the command without being it. */
const SHELL_KEYWORDS = /^(if|then|else|elif|fi|do|done|while|until|for|in|case|esac|!|\{|\}|\[\[|\]\]|function)$/;
/**
 * Wrappers that run their argument list as a command after their own options. `coproc [NAME] cmd`
 * runs cmd in the background with its stdio on a pipe (review round 6, finding 7). For every
 * wrapper the options that consume the next word are listed in {@link WRAPPER_VALUE_OPTIONS}, so
 * `exec -a aws node x.mjs` resolves to node, not aws, and `sudo -u root npm ci` to npm, not root.
 */
const COMMAND_PREFIXES = /^(sudo|doas|env|nohup|nice|command|builtin|exec|time|timeout|stdbuf|setsid|unbuffer|caffeinate|coproc)$/;
/** Per wrapper: the long/short options that take a value as the next word, and the short-option letters that do when they end a cluster (`-Eu root`). */
const WRAPPER_VALUE_OPTIONS = {
	env: { long: /^(-u|--unset|-C|--chdir|-S|--split-string|--default-signal|--ignore-signal|--block-signal)$/, short: "uCS" },
	nice: { long: /^(-n|--adjustment)$/, short: "n" },
	sudo: { long: /^(-u|--user|-g|--group|-C|--close-from|-D|--chdir|-h|--host|-p|--prompt|-r|--role|-t|--type|-T|--command-timeout|-U|--other-user|-R|--chroot)$/, short: "ugCDhprtTUR" },
	doas: { long: /^(-u|-C)$/, short: "uC" },
	timeout: { long: /^(-k|--kill-after|-s|--signal)$/, short: "ks" },
	stdbuf: { long: /^(-i|-o|-e|--input|--output|--error)$/, short: "ioe" },
	exec: { long: /^-a$/, short: "a" },
	time: { long: /^(-f|--format|-o|--output)$/, short: "fo" },
	caffeinate: { long: /^(-t|-w)$/, short: "tw" },
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?[+]?=/;
const CHECKOUT_PATH = /(^|[\/"'=:])(?:\.\/)?(scripts|\.github|packages|node_modules|test|src)\//;
const WORKSPACE_PATH = /\$\{?(GITHUB_WORKSPACE|RUNNER_WORKSPACE)\}?\/(scripts|\.github|packages|node_modules|test|src)\//;
const SCRIPT_EXTENSION = /\.(m?[jt]s|c[jt]s|sh|bash|zsh|py|rb|pl)$/;
const REDIRECTION = /^[0-9]*(<<<|<<-?|<>|>>|>\||>&|<&|&>>|&>|<|>)/;

/**
 * Joins backslash-continued lines so a command and its arguments are inspected together. Bash
 * removes a trailing backslash-newline without inserting anything, so the halves join with NO
 * character: `node node_mod\` over a line break is `node node_modules/...`, not `node node_mod
 * ules/...` - anything else would let a word be spelled across the join unseen (review round 9,
 * finding 1).
 */
function joinContinuations(script) {
	const lines = [];
	let pending = "";
	for (const line of String(script).split("\n")) {
		const trailing = line.match(/(\\+)$/);
		if (trailing && trailing[1].length % 2 === 1) {
			pending += line.slice(0, -1);
			continue;
		}
		lines.push(pending + line);
		pending = "";
	}
	if (pending) lines.push(pending);
	return lines;
}

const ANSI_C_ESCAPES = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b", E: "\x1b", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/**
 * The command substitutions an arithmetic body runs, surfaced for the walks that inspect
 * `substitutions`: `x=$(( $($file) ))` executes the artifact the loop variable names (review
 * round 8, finding 3). Pure arithmetic (`count + 1`) is data, so it stays out of command analysis.
 */
function arithmeticSubstitutions(body) {
	const substitutions = [];
	for (const command of splitWords(body).commands) substitutions.push(...command.substitutions);
	return substitutions;
}

/**
 * The position of the `case` that opens a `case ... in` construct, after any assignments and
 * keywords that share its line (`do case "$x" in`); -1 when the first word that is neither an
 * assignment nor a keyword is anything else (`echo case x in` is an echo).
 */
function caseHeadIndex(words) {
	for (const [position, word] of words.entries()) {
		if (!word.quoted && word.text === "case") return position;
		if (ASSIGNMENT.test(word.text) || SHELL_KEYWORDS.test(word.text)) continue;
		return -1;
	}
	return -1;
}

/**
 * POSIX-ish word splitting of one command line.
 *
 * Adjacent quoted and unquoted fragments form ONE word (`'node scr'"'"'ipts/x'` is the word
 * `node scripts/x`). Single quotes are literal, double quotes honour backslash escapes, a
 * backslash outside quotes escapes the next character, `$'...'` is ANSI-C quoted. `$(...)`,
 * backticks, `<(...)`, `>(...)` are kept literally in the word and their inner text is returned in
 * `substitutions` so the caller can inspect what they would run. `;`, `&&`, `||`, `|`, `&`, `(`
 * and `)` end the command; a `#` at the start of a word ends the line. Redirections are dropped.
 *
 * Returns `{ commands, unterminated }` where each command is `{ words, substitutions }` and each
 * word is `{ text, expansion }` - `expansion` is true when the word contains something the shell
 * would expand (`$var`, `$(...)`, backticks), so its value cannot be known statically.
 */
export function splitWords(line, { patternPosition = false } = {}) {
	const commands = [];
	let words = [];
	let substitutions = [];
	let redirections = [];
	let piped = false;
	let nextPiped = false;
	let pendingOpens = 0;
	let text = "";
	let expansion = false;
	let inWord = false;
	let quoted = false;
	let definesFunction = false;
	let nul = false;
	let unterminated = false;
	// True while the next words are `case` patterns (`a|b)`), i.e. right after `case X in` or `;;`
	// and until the `)` that ends the pattern list. Patterns are data, not commands.
	let pattern = patternPosition;
	const source = String(line);
	let i = 0;

	const endWord = () => {
		if (inWord) {
			// `esac` in pattern position closes the case statement.
			if (pattern && words.length === 0 && text === "esac" && !quoted) pattern = false;
			words.push({ text, expansion, quoted, definesFunction, nul });
		}
		text = "";
		expansion = false;
		inWord = false;
		quoted = false;
		definesFunction = false;
		nul = false;
	};
	const endCommand = () => {
		endWord();
		// `case X in` begins the patterns; `do case X in` may open the case on the same line.
		const caseAt = caseHeadIndex(words);
		if (caseAt !== -1 && words[caseAt + 2]?.text === "in" && caseAt + 2 === words.length - 1) pattern = true;
		if (words.length > 0 || substitutions.length > 0 || redirections.length > 0) {
			// `opens` counts the `(` that preceded this command, `closes` the `)` that followed it,
			// so a caller can scope a `cd` inside `( ... )` to the subshell.
			commands.push({ words, substitutions, redirections, piped, opens: pendingOpens, closes: 0, casePattern: false, background: false });
			pendingOpens = 0;
		}
		words = [];
		substitutions = [];
		redirections = [];
		piped = nextPiped;
		nextPiped = false;
	};
	/** Ends a `case` pattern segment (`a|`, `b)`): the words are patterns and never a command. */
	const endPattern = () => {
		endWord();
		if (words.length > 0 || substitutions.length > 0) {
			commands.push({ words, substitutions, redirections, piped: false, opens: 0, closes: 0, casePattern: true, background: false });
		}
		words = [];
		substitutions = [];
		redirections = [];
		nextPiped = false;
	};
	/** Scans a `$(`/`<(`/`>(` or `$((` body from `start` (just past the opener); returns [inner, end index after the closer]. */
	const scanParens = (start, arithmetic) => {
		let depth = 1;
		let j = start;
		let quote = null;
		while (j < source.length) {
			const ch = source[j];
			if (quote === "'") {
				if (ch === "'") quote = null;
				j += 1;
				continue;
			}
			if (quote === '"') {
				if (ch === "\\") j += 2;
				else {
					if (ch === '"') quote = null;
					else if (ch === "$" && source[j + 1] === "(") {
						const [, end] = scanParens(j + 2, source[j + 2] === "(");
						j = end;
						continue;
					}
					j += 1;
				}
				continue;
			}
			if (ch === "\\") {
				j += 2;
				continue;
			}
			if (ch === "'" || ch === '"') quote = ch;
			else if (ch === "(") depth += 1;
			else if (ch === ")") {
				depth -= 1;
				if (depth === 0) {
					if (arithmetic && source[j + 1] === ")") return [source.slice(start, j), j + 2];
					if (!arithmetic) return [source.slice(start, j), j + 1];
				}
			}
			j += 1;
		}
		unterminated = true;
		return [source.slice(start), source.length];
	};

	/** Index just past the word starting at `start`, honouring quotes, escapes and nested substitutions. */
	const wordExtent = (start) => {
		let j = start;
		while (j < source.length) {
			const c = source[j];
			if (c === "'") {
				const close = source.indexOf("'", j + 1);
				j = close === -1 ? source.length : close + 1;
			} else if (c === '"') {
				j += 1;
				while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
				j += 1;
			} else if (c === "\\") j += 2;
			else if ((c === "$" || c === "<" || c === ">") && source[j + 1] === "(") {
				const arithmetic = c === "$" && source[j + 2] === "(";
				[, j] = scanParens(j + 2 + (arithmetic ? 1 : 0), arithmetic);
			} else if (c === "`") {
				const close = source.indexOf("`", j + 1);
				j = close === -1 ? source.length : close + 1;
			} else if (" \t\n;|&()".includes(c)) break;
			else j += 1;
		}
		return Math.min(j, source.length);
	};

	while (i < source.length) {
		const ch = source[i];
		if (ch === " " || ch === "\t" || ch === "\n") {
			// A bare `{` or `}` is a reserved word that begins or ends a group: what follows it on the
			// same line is a separate command (`function f { node x; }` runs node; review round 6, finding 7).
			const groupBrace = inWord && !quoted && !expansion && (text === "{" || text === "}");
			if (ch === "\n" || groupBrace) endCommand();
			else endWord();
			i += 1;
			continue;
		}
		if (!inWord && ch === "#") break;
		if (ch === "'") {
			inWord = true;
			quoted = true;
			const close = source.indexOf("'", i + 1);
			if (close === -1) {
				unterminated = true;
				text += source.slice(i + 1);
				i = source.length;
			} else {
				text += source.slice(i + 1, close);
				i = close + 1;
			}
			continue;
		}
		if (ch === '"') {
			inWord = true;
			quoted = true;
			i += 1;
			let closed = false;
			while (i < source.length) {
				const c = source[i];
				if (c === "\\") {
					const next = source[i + 1];
					if (next === undefined) {
						i += 1;
						break;
					}
					if (next === "\n") i += 2;
					else if ('$`"\\'.includes(next)) {
						text += next;
						i += 2;
					} else {
						text += `\\${next}`;
						i += 2;
					}
					continue;
				}
				if (c === '"') {
					closed = true;
					i += 1;
					break;
				}
				if (c === "$" && source[i + 1] === "(") {
					const arithmetic = source[i + 2] === "(";
					const [inner, end] = scanParens(i + 2 + (arithmetic ? 1 : 0), arithmetic);
					if (arithmetic) substitutions.push(...arithmeticSubstitutions(inner));
					else substitutions.push(inner);
					text += source.slice(i, end);
					expansion = true;
					i = end;
					continue;
				}
				if (c === "`") {
					const close = source.indexOf("`", i + 1);
					const end = close === -1 ? source.length : close + 1;
					if (close === -1) unterminated = true;
					substitutions.push(source.slice(i + 1, close === -1 ? source.length : close));
					text += source.slice(i, end);
					expansion = true;
					i = end;
					continue;
				}
				if (c === "$") expansion = true;
				text += c;
				i += 1;
			}
			if (!closed) unterminated = true;
			continue;
		}
		if (ch === "\\") {
			inWord = true;
			if (i + 1 < source.length) {
				text += source[i + 1];
				i += 2;
			} else i += 1;
			continue;
		}
		if (ch === "$" && source[i + 1] === "'") {
			inWord = true;
			quoted = true;
			i += 2;
			let closed = false;
			while (i < source.length) {
				const c = source[i];
				if (c === "\\") {
					const next = source[i + 1];
					if (next === undefined) {
						i += 1;
						break;
					}
					// Every numeric form bash decodes is decoded here, at bash's own digit limits:
					// `\x2d` (1-2 hex), `\055` (1-3 octal), `\u002d` (1-4 hex), `\U0000002d` (1-8 hex)
					// and `\cX` (control-X) all spell `-` or a control character without writing it,
					// so `$'\U0000002d-checkpoint-action=exec=id'` is the option it decodes to (review
					// round 7, finding 2). A NUL ends the string, as it does in bash; the word is marked.
					let decoded = null;
					let consumed = 2;
					if (next in ANSI_C_ESCAPES) {
						decoded = ANSI_C_ESCAPES[next];
					} else if (next === "x" && /^[0-9a-fA-F]/.test(source.slice(i + 2))) {
						const hex = source.slice(i + 2).match(/^[0-9a-fA-F]{1,2}/)[0];
						decoded = String.fromCodePoint(parseInt(hex, 16));
						consumed = 2 + hex.length;
					} else if (/^[0-7]/.test(next)) {
						const octal = source.slice(i + 1).match(/^[0-7]{1,3}/)[0];
						decoded = String.fromCodePoint(parseInt(octal, 8));
						consumed = 1 + octal.length;
					} else if (next === "u" && /^[0-9a-fA-F]/.test(source.slice(i + 2))) {
						const hex = source.slice(i + 2).match(/^[0-9a-fA-F]{1,4}/)[0];
						decoded = String.fromCodePoint(parseInt(hex, 16));
						consumed = 2 + hex.length;
					} else if (next === "U" && /^[0-9a-fA-F]/.test(source.slice(i + 2))) {
						const hex = source.slice(i + 2).match(/^[0-9a-fA-F]{1,8}/)[0];
						const codePoint = parseInt(hex, 16);
						decoded = codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "\ufffd";
						consumed = 2 + hex.length;
					} else if (next === "c" && i + 2 < source.length) {
						const control = source[i + 2];
						decoded = control === "?" ? "\x7f" : String.fromCharCode(control.toUpperCase().charCodeAt(0) & 0x1f);
						consumed = 3;
					}
					if (decoded === null) {
						text += `\\${next}`;
						i += 2;
						continue;
					}
					i += consumed;
					if (decoded === "\0") {
						// bash stores C strings: the rest of this $'...' is dropped. Adjacent fragments still join.
						nul = true;
						const close = source.indexOf("'", i);
						if (close === -1) {
							unterminated = true;
							i = source.length;
						} else i = close + 1;
						closed = close !== -1;
						break;
					}
					text += decoded;
					continue;
				}
				if (c === "'") {
					closed = true;
					i += 1;
					break;
				}
				text += c;
				i += 1;
			}
			if (!closed) unterminated = true;
			continue;
		}
		if (ch === "$" && source[i + 1] === "(") {
			inWord = true;
			expansion = true;
			const arithmetic = source[i + 2] === "(";
			const [inner, end] = scanParens(i + 2 + (arithmetic ? 1 : 0), arithmetic);
			if (arithmetic) substitutions.push(...arithmeticSubstitutions(inner));
			else substitutions.push(inner);
			text += source.slice(i, end);
			i = end;
			continue;
		}
		if ((ch === "<" || ch === ">") && source[i + 1] === "(") {
			inWord = true;
			expansion = true;
			const [inner, end] = scanParens(i + 2, false);
			substitutions.push(inner);
			text += source.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "`") {
			inWord = true;
			expansion = true;
			const close = source.indexOf("`", i + 1);
			if (close === -1) unterminated = true;
			substitutions.push(source.slice(i + 1, close === -1 ? source.length : close));
			text += source.slice(i, close === -1 ? source.length : close + 1);
			i = close === -1 ? source.length : close + 1;
			continue;
		}
		if (ch === "(" && inWord && /^[A-Za-z_][A-Za-z0-9_]*[+]?=$/.test(text)) {
			// An array assignment: `names=(a b)`, `names+=("$x")`. The parens belong to the word.
			const [inner, end] = scanParens(i + 1, false);
			if (/[$`]/.test(inner)) expansion = true;
			for (const element of splitWords(inner).commands) substitutions.push(...element.substitutions);
			text += source.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "(" && inWord && !quoted && !expansion && !pattern && words.length === 0 && source[i + 1] === ")" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(text)) {
			// A function definition: `name() {`. The word names the function, not a command to run.
			definesFunction = true;
			i += 2;
			endCommand();
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
			// `&&`, `||`, `;;`, `|&` are all command separators too. A single `|` (or `|&`) feeds
			// the next command's stdin, which matters when that command is a shell.
			let operator = ch;
			i += 1;
			while (i < source.length && ";|&".includes(source[i])) operator += source[i++];
			if (pattern && (operator === "|" || operator === "(" || operator === ")")) {
				// Inside a pattern list: `(a|b)` or `a|b)`. `)` ends it; what follows is the body.
				endPattern();
				if (operator === ")") pattern = false;
				continue;
			}
			// `case X in PATTERN)` or `case X in P1|P2)` on one line: the words after `in` are
			// re-emitted as a case pattern command, exactly as a multi-line case would be, so the
			// arm's body is read as its body and a `|` separates patterns, not commands (review
			// round 8, finding 5 - a one-line arm could otherwise skip the bundle unseen).
			const caseAt = caseHeadIndex(words);
			const caseHead = caseAt !== -1 && words[caseAt + 2]?.text === "in" && (operator === "|" || operator === ")");
			if (caseHead) {
				endCommand();
				const closed = commands.pop();
				const patternWords = closed.words.slice(caseAt + 3);
				commands.push({ ...closed, words: closed.words.slice(0, caseAt + 3), closes: 0, piped: false });
				if (patternWords.length > 0) {
					commands.push({ words: patternWords, substitutions: closed.substitutions, redirections: [], piped: false, opens: 0, closes: 0, casePattern: true, background: false });
				}
				pattern = operator === "|"; // more patterns follow a `|`; the body follows the `)`
				continue;
			}
			nextPiped = operator === "|" || operator === "|&";
			endCommand();
			if (operator === "&") {
				// A bare `&` backgrounds the command (or the `{ ...; }`/`( ... )` group) it follows.
				const target = commands[commands.length - 1];
				if (target) target.background = true;
			}
			if (/^;;&?$|^;&$/.test(operator)) pattern = true;
			else if (operator[0] === "(") pendingOpens += 1;
			else if (operator[0] === ")" && commands.length > 0) commands[commands.length - 1].closes += 1;
			continue;
		}
		if (!inWord && (ch === "<" || ch === ">" || (/[0-9]/.test(ch) && REDIRECTION.test(source.slice(i))))) {
			// A redirection: the operator and its target are not a word of the command, but a
			// target such as `< <(node scripts/x.mjs)` still runs something - keep its substitutions.
			const operator = source.slice(i).match(REDIRECTION)[0];
			i += operator.length;
			while (i < source.length && (source[i] === " " || source[i] === "\t")) i += 1;
			const end = wordExtent(i);
			const target = splitWords(source.slice(i, end));
			if (target.unterminated) unterminated = true;
			for (const command of target.commands) substitutions.push(...command.substitutions);
			const word = target.commands[0]?.words[0];
			redirections.push({ operator, text: word?.text ?? "", expansion: word?.expansion ?? false });
			i = end;
			continue;
		}
		if (ch === "$") expansion = true;
		inWord = true;
		text += ch;
		i += 1;
	}
	endCommand();
	return { commands, unterminated, patternPosition: pattern };
}

/**
 * Splits a `run` block into simple commands. Yields `{ words, substitutions, redirections }` per
 * command, where each word is `{ text, expansion }`.
 *
 * Heredocs are recognised from the parsed redirections (never from a regex over the raw line, so
 * a here-string such as `<<<"$ref"` cannot open a fake heredoc that swallows the rest of the
 * script). EVERY heredoc body is re-parsed as shell and yielded too - whatever program the
 * heredoc feeds, a `node scripts/x.mjs` written in it is inspected. Feeding an interpreter from a
 * heredoc is separately an error in credential-bearing jobs (see repositoryCodeReasons).
 */
export function* shellCommands(script) {
	const heredocs = []; // pending delimiters for the current line, in order
	let heredoc = null; // { delimiter, stripTabs }
	let heredocBody = [];
	let carried = "";
	let patternPosition = false; // inside a `case`, between `in`/`;;` and the next `)`
	const finishHeredoc = function* () {
		const body = heredocBody.join("\n");
		heredocBody = [];
		heredoc = heredocs.shift() ?? null;
		// The body is data for whatever reads it; it is inspected, and marked so the command
		// allowlist does not read prose as commands (an interpreter reading it is an error anyway).
		for (const command of shellCommands(body)) yield { ...command, heredoc: true };
	};
	for (const rawLine of joinContinuations(script)) {
		if (heredoc !== null) {
			const candidate = heredoc.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
			if (candidate === heredoc.delimiter) yield* finishHeredoc();
			else heredocBody.push(rawLine);
			continue;
		}
		const line = carried ? `${carried}\n${rawLine}` : rawLine;
		const parsed = splitWords(line, { patternPosition });
		const { commands, unterminated } = parsed;
		if (unterminated) {
			// A quote or substitution spans lines; keep reading until it closes.
			carried = line;
			continue;
		}
		carried = "";
		patternPosition = parsed.patternPosition;
		for (const command of commands) {
			for (const entry of command.redirections) {
				const operator = entry.operator.replace(/^[0-9]+/, "");
				if (operator === "<<" || operator === "<<-") heredocs.push({ delimiter: entry.text, stripTabs: operator === "<<-" });
			}
			yield command;
		}
		heredoc = heredocs.shift() ?? null;
	}
	// An unterminated heredoc at the end of the script: inspect what we have, never drop it.
	while (heredoc !== null) yield* finishHeredoc();
	if (carried) {
		// An unterminated construct at the end of the script: inspect what we have, never drop it.
		for (const command of splitWords(carried).commands) yield command;
	}
}

function asCommand(input) {
	if (Array.isArray(input)) {
		return { words: input.map((text) => ({ text: String(text), expansion: /[$`]/.test(String(text)), quoted: false, definesFunction: false })), substitutions: [], redirections: [], piped: false, opens: 0, closes: 0, casePattern: false, heredoc: false, background: false };
	}
	return { redirections: [], piped: false, opens: 0, closes: 0, casePattern: false, heredoc: false, background: false, ...input };
}

/**
 * The index of the word that names the command, after assignments, keywords and wrappers; -1 when
 * there is none. Wrappers nest (`sudo env X=1 exec -a name cmd`), and keywords may follow a wrapper
 * (`coproc NAME { cmd; }`), so the walk repeats until a word is neither. A wrapper option the
 * checker does not know is reported through `reasons`: it cannot tell whether that option consumed
 * the word that follows, so the command may be misread (review round 6, findings 4, 6, 7).
 */
function commandIndex(words, reasons = []) {
	let index = 0;
	for (;;) {
		while (index < words.length && (ASSIGNMENT.test(words[index].text) || SHELL_KEYWORDS.test(words[index].text))) {
			// `for NAME in ...`, `case WORD in ...`, `[[ ... ]]`, `[ ... ]` name no command to execute.
			if (/^(for|case|\[\[|\[|select)$/.test(words[index].text)) return -1;
			index += 1;
		}
		if (index >= words.length || !COMMAND_PREFIXES.test(words[index].text) || words[index].expansion) break;
		// Wrappers: `sudo -E cmd`, `env -i VAR=x cmd`, `timeout 10 cmd`, `exec -a name cmd`, `coproc NAME { cmd; }`.
		const wrapper = words[index].text;
		index += 1;
		if (wrapper === "coproc" && index + 1 < words.length && words[index + 1].text === "{" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(words[index].text) && !words[index].expansion) {
			index += 1; // the coprocess name; the `{` that follows is skipped as a keyword
			continue;
		}
		if (wrapper === "env") {
			for (const option of words.slice(index)) {
				if (!option.text.startsWith("-")) break;
				if (/^-[A-Za-z]*S|^--split-string/.test(option.text)) reasons.push(`env -S splits a string into a command the checker cannot see: ${option.text}`);
			}
		}
		if (wrapper === "command" && /^-[vV]/.test(words[index]?.text ?? "")) return -1; // `command -v x` only looks x up
		const valueOptions = WRAPPER_VALUE_OPTIONS[wrapper];
		let positional = wrapper === "timeout" ? 1 : 0;
		while (index < words.length) {
			const word = words[index];
			if (word.text.startsWith("-") && word.text !== "-") {
				index += 1;
				if (word.text === "--") break;
				if (word.expansion) reasons.push(`${wrapper} carries an option built from an expansion, so the checker cannot tell which word is the command: ${word.text}`);
				if (valueOptions && (valueOptions.long.test(word.text) || (/^-[A-Za-z]+$/.test(word.text) && valueOptions.short.includes(word.text.at(-1))))) index += 1;
				continue;
			}
			if (ASSIGNMENT.test(word.text)) {
				index += 1;
				continue;
			}
			if (positional > 0) {
				positional -= 1;
				index += 1;
				continue;
			}
			break;
		}
	}
	return index < words.length ? index : -1;
}

function commandWordOf(command) {
	const index = commandIndex(command.words);
	return index === -1 ? undefined : command.words[index];
}

/**
 * Resolves a relative, literal word against the working directory the step has `cd`-ed into.
 * Returns null for words that are not paths a program would open: options, expansions, absolute
 * paths, assignments and URLs.
 */
function resolveAgainst(cwd, word) {
	const text = word.text;
	if (!cwd || !text || word.expansion || text.startsWith("-") || text.startsWith("/") || text.includes("://") || ASSIGNMENT.test(text) || SHELL_KEYWORDS.test(text)) return null;
	return posix.normalize(posix.join(cwd, text));
}

/** The relative directories `actions/download-artifact` fills in this job; the only places a credential-bearing step may `cd` into. */
export function artifactDirectoriesOf(job) {
	const directories = [];
	for (const step of job.steps ?? []) {
		if (!step.uses?.startsWith("actions/download-artifact@")) continue;
		const path = step.with?.path;
		if (typeof path !== "string" || !LITERAL_DIRECTORY.test(path)) continue;
		directories.push(posix.normalize(path));
	}
	return directories;
}
const LITERAL_DIRECTORY = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/** True when `directory` (already resolved against the workspace root) is a downloaded artifact directory or lies inside one. */
export function isArtifactDirectory(directory, artifactDirectories) {
	if (typeof directory !== "string" || directory.includes("$") || directory.includes("{") || directory.startsWith("/") || directory.startsWith("-")) return false;
	const normalized = posix.normalize(directory).replace(/\/$/, "");
	if (normalized === "" || normalized === "." || normalized.startsWith("..")) return false;
	return artifactDirectories.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

/**
 * Walks one credential-bearing `run` block in order, tracking the working directory. Returns the
 * reasons the block would run repository code or move to a directory the checker does not allow.
 *
 * `cd` and `pushd` may only target a downloaded artifact directory, spelled literally; `popd`,
 * `chdir`, `cd` with no target, `cd -`, `cd ..` and any target with an expansion are errors.
 * Inside `( ... )` the directory change is scoped to the subshell.
 */
export function credentialStepReasons(run, { artifactDirectories = [], workingDirectory = "", jobId = null, env } = {}) {
	const reasons = [];
	let cwd = workingDirectory && isArtifactDirectory(workingDirectory, artifactDirectories) ? posix.normalize(workingDirectory).replace(/\/$/, "") : "";
	const stack = [];
	const functions = new Set();
	// The variables the step starts with: the runner's, plus the job's and step's `env:`. An env
	// value that is a literal not beginning with `-` can never be an option; an expression
	// (`${{ needs.* }}`, `${{ secrets.* }}`) is data the checker cannot see. Without `env` (unit
	// tests) every allowlisted name counts as bound, and none as prefixed.
	const state = { bound: new Set(GITHUB_DEFAULT_ENV), prefixed: new Set(GITHUB_DEFAULT_ENV), functions, values: new Map() };
	if (env === undefined) for (const name of ALLOWED_VARIABLES) state.bound.add(name);
	else {
		for (const [name, value] of Object.entries(env)) {
			state.bound.add(name);
			if (typeof value === "string" && value !== "" && !value.includes("${{") && !value.startsWith("-") && !value.startsWith("$")) state.prefixed.add(name);
		}
	}
	for (const command of shellCommands(run)) {
		for (let n = 0; n < (command.opens ?? 0); n += 1) stack.push(cwd);
		for (const reason of repositoryCodeReasons(command, cwd)) reasons.push(`must not run repository code: ${reason}`);
		reasons.push(...commandAllowlistReasons(command, { jobId, functions, artifactDirectories, values: state.values, cwd }));
		reasons.push(...expansionReasons(command, state, { artifactDirectories, cwd }));
		const index = commandIndex(command.words);
		if (index !== -1) {
			const name = command.words[index].text;
			if (DIRECTORY_COMMANDS.test(name)) {
				const args = command.words.slice(index + 1).filter((word) => !(/^-[LPe@]+$/.test(word.text) && !word.expansion));
				const target = args[0];
				const spelled = command.words.slice(index).map((word) => word.text).join(" ");
				if (name === "popd" || name === "chdir") {
					reasons.push(`changes directory in a way the checker cannot follow: ${spelled}`);
				} else if (!target || args.length > 1 || target.expansion || target.text === "-" || target.text === "--") {
					reasons.push(`changes directory to a target the checker cannot resolve: ${spelled}`);
				} else {
					const resolved = posix.normalize(posix.join(cwd, target.text)).replace(/\/$/, "");
					if (!isArtifactDirectory(resolved, artifactDirectories)) {
						reasons.push(`changes directory outside the downloaded artifacts (${artifactDirectories.join(", ") || "none"}): ${spelled}`);
					}
					// Follow the change either way, so what runs next is resolved against where it really runs.
					cwd = resolved === "." ? "" : resolved;
				}
			}
		}
		for (let n = 0; n < (command.closes ?? 0); n += 1) if (stack.length > 0) cwd = stack.pop();
	}
	return reasons;
}

/**
 * Returns the reasons a simple command would execute or read repository code, or would run
 * something the checker cannot see. `input` is a command from {@link shellCommands} (or a plain
 * array of words for convenience).
 */
export function repositoryCodeReasons(input, cwd = "") {
	const { words, substitutions, redirections, piped } = asCommand(input);
	const reasons = [];
	for (const substitution of substitutions) {
		for (const inner of shellCommands(substitution)) {
			for (const reason of repositoryCodeReasons(inner, cwd)) reasons.push(`inside a command substitution: ${reason}`);
			for (const word of inner.words) {
				if (word.text.includes("://")) continue;
				if (SCRIPT_EXTENSION.test(word.text) || /^\.{1,2}\//.test(word.text)) {
					reasons.push(`a command substitution names a script the checker cannot follow: $(${substitution.trim()})`);
					break;
				}
			}
		}
	}
	const commandAt = commandIndex(words);
	for (const [position, word] of words.entries()) {
		if (word.text.includes("://")) continue; // a URL, e.g. the cosign certificate identity
		if (CHECKOUT_PATH.test(word.text) || WORKSPACE_PATH.test(word.text)) {
			reasons.push(`references the checkout: ${word.text}`);
		} else if (cwd && !(position === commandAt && !word.text.includes("/"))) {
			// A bare command name is looked up on PATH, never in the working directory.
			// The step has `cd`-ed somewhere: a bare name resolves against that directory.
			const resolved = resolveAgainst(cwd, word);
			if (resolved !== null && CHECKOUT_PATH.test(resolved)) {
				reasons.push(`references the checkout: ${word.text} resolves to ${resolved} from working directory ${cwd}`);
			}
		}
		if (/^(export\s+)?PATH=/.test(word.text)) reasons.push(`modifies PATH, so a bare command name may resolve to the checkout: ${word.text}`);
	}
	for (const redirection of redirections) {
		if (redirection.text.includes("://")) continue;
		if (CHECKOUT_PATH.test(redirection.text) || WORKSPACE_PATH.test(redirection.text)) {
			reasons.push(`redirects the checkout: ${redirection.operator}${redirection.text}`);
		} else if (cwd) {
			const resolved = resolveAgainst(cwd, redirection);
			if (resolved !== null && CHECKOUT_PATH.test(resolved)) {
				reasons.push(`redirects the checkout: ${redirection.operator}${redirection.text} resolves to ${resolved} from working directory ${cwd}`);
			}
		}
	}
	const index = commandIndex(words, reasons);
	if (index !== -1 && /^(export|declare|readonly|local|typeset)$/.test(words[index].text) && words.slice(index + 1).some((word) => /^PATH(=|$)/.test(word.text))) {
		reasons.push(`modifies PATH, so a bare command name may resolve to the checkout: ${words[index].text} PATH`);
	}
	// A variable that loads or runs code is refused however it is set: as a plain assignment with no
	// command (`LD_PRELOAD=x` - exported by `set -a` or an earlier export), as a prefix, through
	// `export`/`declare`/`read`/`printf -v`, or handed to a wrapper (review round 6, finding 7).
	const spelledAll = words.map((word) => word.text).join(" ");
	const assignedHere = assignedNames({ words });
	for (const name of new Set(assignedHere)) {
		if (STARTUP_ENV.test(name) && name !== "PATH") reasons.push(`sets ${name}, which loads code before the command runs or changes how a name resolves: ${spelledAll}`);
	}
	// `read PATH`, `printf -v PATH`, `printf -vPATH`, `mapfile PATH`: an assigning builtin naming PATH.
	if (assignedHere.includes("PATH") && commandAt !== -1 && ASSIGNING_COMMANDS.test(words[commandAt].text)) {
		reasons.push(`modifies PATH, so a bare command name may resolve to the checkout: ${spelledAll}`);
	}
	for (const word of words) {
		// Any assignment word the walk above did not attribute (`env NODE_OPTIONS=--import=x node ...` behind an unknown option).
		const name = ASSIGNMENT.test(word.text) ? word.text.match(/^[A-Za-z_][A-Za-z0-9_]*/)[0] : null;
		if (name && name !== "PATH" && STARTUP_ENV.test(name) && !assignedHere.includes(name)) {
			reasons.push(`sets ${name}, which loads code before the command runs or changes how a name resolves: ${word.text}`);
		}
	}
	if (index === -1) return reasons;
	const commandWord = words[index];
	const command = commandWord.text;
	const args = words.slice(index + 1);
	if (commandWord.expansion) {
		reasons.push(`the command is a shell expansion the checker cannot resolve: ${command}`);
	}
	if (/^\.{1,2}\//.test(command) || (command.includes("/") && !command.startsWith("/"))) {
		reasons.push(`executes a relative path: ${command}`);
	}
	if (OPAQUE_EXECUTORS.test(command)) {
		reasons.push(`${command} runs a command the checker cannot see`);
	}
	if (RESOLUTION_BUILTINS.test(command)) {
		reasons.push(`${command} changes how commands resolve or run, which the checker cannot follow`);
	}
	if (NAMEREF_COMMANDS.test(command) && args.some((arg) => /^-[A-Za-z]*n/.test(arg.text) && !arg.expansion)) {
		reasons.push(`${command} -n creates a name reference, so a later assignment may set any variable (PATH, BASH_ENV, ...): ${spelledAll}`);
	}
	if (NAMEREF_COMMANDS.test(command) && args.some((arg) => arg.text.startsWith("-") && arg.expansion)) {
		reasons.push(`${command} carries an option built from an expansion the checker cannot see: ${spelledAll}`);
	}
	if (PACKAGE_MANAGERS.test(command)) {
		const sub = args[0]?.text ?? "";
		if (command !== "npm" || !/^(publish|--version|-v)$/.test(sub)) {
			reasons.push(`runs a package manager: ${command} ${sub}`.trim());
		} else if (sub === "publish" && !ignoreScriptsEnabled(args)) {
			reasons.push(`npm publish runs the package's publish lifecycle scripts without --ignore-scripts: ${words.map((word) => word.text).join(" ")}`);
		}
	}
	if (SOURCE_COMMANDS.test(command) && args.length > 0) {
		reasons.push(`sources a file: ${command} ${args[0].text}`);
	}
	if (command === "find" && args.some((arg) => /^-(exec|execdir|ok|okdir)$/.test(arg.text))) {
		reasons.push("find -exec runs a command the checker cannot see");
	}
	if (INTERPRETERS.test(command)) {
		// The command allowlist refuses every interpreter in a credential-bearing job. This walk
		// still says precisely what the line would do: anything but inline code written here after
		// the flag that introduces it (`node -e`, `python3 -c`) - a pipe, a file, stdin, a heredoc, a
		// here-string, an expansion, a preload option, a shell `-c` string - is code the checker
		// cannot see.
		if (piped) reasons.push(`${command} reads its script from a pipe the checker cannot see`);
		for (const redirection of redirections) {
			const operator = redirection.operator.replace(/^[0-9]+/, "");
			if (operator === "<<" || operator === "<<-") {
				reasons.push(`${command} reads its script from a heredoc the checker cannot follow: ${redirection.operator}${redirection.text}`);
			} else if (operator === "<<<") {
				reasons.push(`${command} reads its script from a here-string the checker cannot follow: ${redirection.operator}${redirection.text}`);
			} else if (operator.startsWith("<")) {
				reasons.push(`${command} reads its script from a file: ${redirection.operator}${redirection.text}`);
			}
		}
		const inlineFlag = INLINE_CODE_FLAGS[command];
		for (const [position, arg] of args.entries()) {
			if (arg.text === "-") {
				reasons.push(`${command} reads its script from stdin (-), which the checker cannot see`);
				break;
			}
			if (arg.text === "--") {
				const next = args[position + 1];
				if (next) reasons.push(`runs a file through ${command}: ${next.text}`);
				break;
			}
			if (arg.text.startsWith("-") && !arg.expansion) {
				if (INTERPRETER_INFO_FLAGS.test(arg.text)) continue;
				if (SHELLS.test(command)) {
					reasons.push(`${command} ${arg.text} runs inline or piped shell code the checker cannot see`);
					break;
				}
				if (inlineFlag?.test(arg.text)) {
					const code = args[position + 1];
					if (!code) reasons.push(`${command} ${arg.text} names no inline code`);
					else if (code.expansion) reasons.push(`${command} ${arg.text} runs code from an expansion the checker cannot see: ${code.text}`);
					break; // inline code follows; its arguments are data
				}
				reasons.push(`${command} carries an option the checker does not allow (only ${inlineFlag ? `${inlineFlag.source.slice(2, -2).replaceAll("|", ", ")}, ` : ""}--version and --help): ${arg.text}`);
				break;
			}
			if (arg.expansion && arg.text.startsWith("-")) {
				reasons.push(`${command} carries an option built from an expansion the checker cannot see: ${arg.text}`);
				break;
			}
			// The first positional argument is the script file. Whatever it is called, it is a file
			// on this runner that the checker did not write.
			reasons.push(`runs a file through ${command}: ${arg.text}`);
			break;
		}
	}
	return reasons;
}

/** True when a word that looks like an option has an expansion in its name part (`"--$FLAG"`, `--${x}=1`), so the checker cannot know which option it is. */
function optionNameExpands(word) {
	return word.text.startsWith("-") && word.expansion && /[$`]/.test(word.text.split("=")[0]);
}

/** POSIX character classes a `case` pattern may name, as JavaScript class members. */
const POSIX_CLASSES = {
	upper: "A-Z",
	lower: "a-z",
	alpha: "A-Za-z",
	digit: "0-9",
	alnum: "A-Za-z0-9",
	space: "\\t\\n\\v\\f\\r ",
	blank: "\\t ",
	punct: "\\u0021-\\u002f\\u003a-\\u0040\\u005b-\\u0060\\u007b-\\u007e",
	cntrl: "\\u0000-\\u001f\\u007f",
	xdigit: "0-9A-Fa-f",
	graph: "\\u0021-\\u007e",
	print: "\\u0020-\\u007e",
	word: "A-Za-z0-9_",
};
/** A bracket expression the translator cannot read matches every name, so a skip pattern can never be under-read. */
const MATCH_ALL = /^[\s\S]*$/;

/**
 * Reads the bracket expression at `pattern[start]` (a `[`), as `[javascriptClass, indexAfter]` or
 * null when it cannot be translated. A POSIX character class spans to its own `]`, so
 * `[[:upper:]]HA256SUMS.sigstore.json` ends at the LAST `]`, not the first (review round 8, finding
 * 6); `[!...]`/`[^...]` negate; a `]` first in the set and ranges are members. An unterminated `[`
 * is the literal `[` bash reads; an unknown character class is unreadable (the caller fails closed).
 */
function bracketExpression(pattern, start) {
	let j = start + 1;
	let negated = false;
	if (pattern[j] === "!" || pattern[j] === "^") {
		negated = true;
		j += 1;
	}
	let members = "";
	if (pattern[j] === "]") {
		members += "\\]";
		j += 1;
	}
	while (j < pattern.length && pattern[j] !== "]") {
		if (pattern[j] === "[" && pattern[j + 1] === ":") {
			const close = pattern.indexOf(":]", j + 2);
			if (close === -1) return null;
			const translated = POSIX_CLASSES[pattern.slice(j + 2, close)];
			if (translated === undefined) return null;
			members += translated;
			j = close + 2;
			continue;
		}
		const member = pattern[j];
		members += member === "\\" ? "\\\\" : member === "]" ? "\\]" : member === "^" ? "\\^" : member;
		j += 1;
	}
	if (j >= pattern.length) return ["\\[", start + 1]; // an unterminated `[` is literal
	return [negated ? `[^${members}]` : `[${members}]`, j + 1];
}

/**
 * A glob from a `case` pattern as a regular expression (`*`, `?`, bracket expressions; everything
 * else literal). A bracket expression that cannot be translated makes the whole pattern match every
 * name: the only question it answers is "could this skip pattern name the signature bundle", and
 * an unreadable pattern may (review round 8, finding 6).
 */
function globToRegExp(pattern) {
	let source = "^";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "*") {
			source += ".*";
			i += 1;
		} else if (ch === "?") {
			source += ".";
			i += 1;
		} else if (ch !== "[") {
			source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			i += 1;
		} else {
			const bracket = bracketExpression(pattern, i);
			if (bracket === null) return MATCH_ALL;
			source += bracket[0];
			i = bracket[1];
		}
	}
	return new RegExp(`${source}$`);
}

/**
 * True when a command in a `case` arm's body leaves the loop or the step: a `continue`, `break`,
 * `exit` or `return` in command position (or inside one of its command substitutions), or a call to
 * a shell function the run block defined whose body - directly or through the functions it calls -
 * does the same (review round 8, finding 5). `continue` and `break` inside a function still act on
 * the caller's loop; `exit` ends the step; a body that might do any of the four never reaches the
 * upload that follows.
 */
function leavesTheItem(command, effects) {
	const walk = (entry) => {
		for (const substitution of entry.substitutions) {
			for (const inner of shellCommands(substitution)) if (walk(inner)) return true;
		}
		const index = commandIndex(entry.words);
		if (index === -1) return false;
		const word = entry.words[index];
		if (word.expansion) return false; // cannot name a function or a control-flow word
		return /^(continue|break|exit|return)$/.test(word.text) || (effects.get(word.text)?.size ?? 0) > 0;
	};
	return walk(command);
}

/**
 * The control-flow effects (`continue`, `break`, `exit`, `return`) of every shell function the run
 * block defines, as a name -> effect map (review round 8, finding 5). A body collects the effects of
 * its own commands and the names it calls in command position; after the walk the call graph is
 * resolved transitively (cycles are safe: a visited function contributes what was already found).
 */
function functionEffectsOf(run) {
	const commands = [...shellCommands(run)].filter((command) => !command.casePattern && !command.heredoc);
	const bodies = new Map(); // name -> { effects: Set, calls: Set }
	const scopes = []; // the functions whose body is currently open, innermost last
	for (const command of commands) {
		const words = command.words;
		const texts = words.map((word) => word.text);
		const index = commandIndex(words);
		// A definition: `name() {` (the `{` is the next command) or `function name {`.
		if (index !== -1 && !words[index].expansion && (words[index].definesFunction || (index > 0 && texts[index - 1] === "function"))) {
			bodies.set(texts[index], { effects: new Set(), calls: new Set() });
			// The `{` may close this very command (`function name {`); else it is the next one.
			scopes.push({ name: texts[index], depth: texts.at(-1) === "{" ? 1 : 0 });
			continue;
		}
		const bare = words.length === 1 && !words[0].expansion;
		if (bare && texts[0] === "{") {
			// The `{` that opens a `name() {` body, or a nested group inside one.
			if (scopes.length > 0) scopes[scopes.length - 1].depth += 1;
			continue;
		}
		if (bare && texts[0] === "}") {
			if (scopes.length > 0 && (scopes[scopes.length - 1].depth -= 1) === 0) scopes.pop();
			continue;
		}
		if (scopes.length === 0) continue;
		// Everything else belongs to the innermost open body: its control-flow words, and the
		// functions it calls (resolved once the whole block has been walked).
		const body = bodies.get(scopes[scopes.length - 1].name);
		const walk = (entry) => {
			for (const substitution of entry.substitutions) {
				for (const inner of shellCommands(substitution)) walk(inner);
			}
			const at = commandIndex(entry.words);
			if (at === -1) return;
			const word = entry.words[at];
			if (word.expansion) return;
			if (/^(continue|break|exit|return)$/.test(word.text)) body.effects.add(word.text);
			else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word.text)) body.calls.add(word.text);
		};
		walk(command);
	}
	const resolved = new Map();
	const resolve = (name, seen) => {
		const body = bodies.get(name);
		if (!body) return new Set();
		const effects = new Set(body.effects);
		if (seen.has(name)) return effects; // a call cycle: its direct effects are all it can add
		seen.add(name);
		for (const call of body.calls) for (const effect of resolve(call, seen)) effects.add(effect);
		return effects;
	};
	for (const name of bodies.keys()) resolved.set(name, resolve(name, new Set()));
	return resolved;
}

/**
 * The `case` patterns (as glob strings) whose body leaves the loop or the step - `continue`, `break`,
 * `exit`, `return`, directly or through a shell function the block defined - i.e. the names an upload
 * loop skips.
 */
export function caseSkipPatternsOf(run) {
	const effects = functionEffectsOf(run);
	const skipped = [];
	let group = [];
	let body = [];
	const flush = () => {
		if (group.length > 0 && body.some((command) => leavesTheItem(command, effects))) {
			skipped.push(...group);
		}
		group = [];
		body = [];
	};
	let inBody = false;
	for (const command of shellCommands(run)) {
		if (command.casePattern) {
			if (inBody) flush();
			inBody = false;
			// A pattern built from an expansion can match anything: it is recorded as the match-all glob.
			group.push(...command.words.map((word) => (word.expansion ? "*" : word.text)));
		} else if (group.length > 0) {
			inBody = true;
			body.push(command);
		}
	}
	flush();
	return skipped;
}

/** True when a `case` pattern in `run` whose body skips the item would (or, if built from an expansion, could) match `name`. */
export function casePatternMatches(run, name) {
	return caseSkipPatternsOf(run).some((pattern) => globToRegExp(pattern).test(name));
}

/**
 * Returns the reasons a simple command in a credential-bearing job runs something outside
 * {@link ALLOWED_COMMANDS} (review round 5, finding 1), sets an environment variable that redirects
 * a credential or a tool's configuration ({@link CREDENTIAL_ENV}), names a configuration dotfile, or
 * uses an allowlisted tool in a way that runs code (`gh extension`, `git --upload-pack`,
 * `tar --to-command`, `curl` without `--proto '=https'`).
 *
 * `functions` is the set of shell functions the block has defined so far (a definition adds to it;
 * a call to a defined function is allowed). `jobId` selects the per-job allowlist; without one only
 * the `*` set applies.
 */
export function commandAllowlistReasons(input, { jobId = null, functions = new Set(), artifactDirectories = [], values, cwd = "" } = {}) {
	const command = asCommand(input);
	const reasons = [];
	for (const substitution of command.substitutions) {
		for (const inner of shellCommands(substitution)) {
			for (const reason of commandAllowlistReasons(inner, { jobId, functions, artifactDirectories, values, cwd })) reasons.push(`inside a command substitution: ${reason}`);
		}
	}
	const words = command.words;
	const spelled = words.map((word) => word.text).join(" ");
	for (const word of words) {
		// A control character (from `$'\cM'`, `$'\x1b'`, `$'\n'`) has no place in an argument; only a tab (`IFS=$'\t'`) is data.
		if (/[\x00-\x08\x0a-\x1f\x7f]/.test(word.text)) reasons.push(`a word contains a control character the checker cannot read as an argument: ${JSON.stringify(word.text)} (${spelled})`);
		if (word.text.includes("://")) continue;
		if (CONFIGURATION_PATH.test(word.text)) reasons.push(`names a configuration or credential file the allowlisted tools read: ${word.text} (${spelled})`);
		// `artifacts/../../etc/passwd` in ANY position - a cp source, `test -f`, `sha256sum`, a `for`
		// list, `--notes-file`, an assignment - names a file outside the downloaded artifacts.
		if (!command.casePattern && hasDotSegment(word.text)) reasons.push(`names a path with a . or .. segment; only plainly spelled paths may be read here: ${word.text} (${spelled})`);
	}
	for (const redirection of command.redirections) {
		if (CONFIGURATION_PATH.test(redirection.text)) reasons.push(`redirects to a configuration or credential file the allowlisted tools read: ${redirection.operator}${redirection.text} (${spelled})`);
		if (!redirection.text.includes("://") && hasDotSegment(redirection.text)) reasons.push(`redirects a path with a . or .. segment: ${redirection.operator}${redirection.text} (${spelled})`);
	}
	if (command.casePattern) {
		// A pattern built from an expansion matches whatever the variable holds - `"$skip") continue`
		// could name the signature bundle - so every pattern must be a literal glob (review round 7, finding 4).
		for (const word of words) {
			if (word.expansion) reasons.push(`a case pattern built from an expansion could match any name, including one the loop must not skip: ${word.text} (${spelled})`);
		}
		return reasons;
	}
	if (command.heredoc) return reasons; // data, not commands
	if (command.background) {
		// A backgrounded command's exit status is never seen by `set -e`, and `coproc`/`&` let a
		// command outlive the checks that follow it (review round 6, finding 7).
		reasons.push(`runs a command in the background, so its failure would go unnoticed: ${spelled || "(compound command)"} &`);
	}
	const assigned = new Set(assignedNames(command));
	for (const word of words) {
		if (ASSIGNMENT.test(word.text)) assigned.add(word.text.match(/^[A-Za-z_][A-Za-z0-9_]*/)[0]);
	}
	for (const name of assigned) {
		if (CREDENTIAL_ENV.test(name)) reasons.push(`sets ${name}, which redirects where a credential is sent or which configuration a tool loads: ${spelled}`);
	}
	let start = 0;
	while (start < words.length && (ASSIGNMENT.test(words[start].text) || SHELL_KEYWORDS.test(words[start].text))) {
		if (/^(for|case|\[\[|\[|select)$/.test(words[start].text)) return reasons;
		start += 1;
	}
	if (start >= words.length) return reasons;
	const index = commandIndex(words);
	const describe = `credential-bearing job${jobId ? ` '${jobId}'` : "s"}`;
	// Every wrapper on the line is reported, whether or not a command follows it on the same line
	// (`coproc NAME {` opens a group whose body is the next command).
	for (let position = start; position < (index === -1 ? words.length : index); position += 1) {
		const word = words[position];
		if (!COMMAND_PREFIXES.test(word.text) || word.expansion) continue; // an option, value or assignment of the wrapper
		if (word.text === "command" && /^-[vV]/.test(words[position + 1]?.text ?? "")) continue; // `command -v x` only looks x up
		reasons.push(`runs ${word.text}, a wrapper that hands its arguments to another command; ${describe} may run only the allowlisted commands directly: ${spelled}`);
		if (index === -1) break;
	}
	if (index === -1) return reasons; // `command -v x`, `coproc NAME {`
	const allowed = new Set([...ALLOWED_COMMANDS["*"], ...(ALLOWED_COMMANDS[jobId] ?? [])]);
	const word = words[index];
	const name = word.text;
	if (word.definesFunction || words[index - 1]?.text === "function") {
		// A function may not take the name of anything that is a command anywhere in the release.
		const everyAllowed = new Set(Object.values(ALLOWED_COMMANDS).flat());
		if (everyAllowed.has(name) || DIRECTORY_COMMANDS.test(name) || INTERPRETERS.test(name) || PACKAGE_MANAGERS.test(name) || COMMAND_PREFIXES.test(name) || SHELL_KEYWORDS.test(name) || OPAQUE_EXECUTORS.test(name) || RESOLUTION_BUILTINS.test(name) || SOURCE_COMMANDS.test(name)) {
			reasons.push(`defines a shell function named ${name}, which would shadow that command for the rest of the step: ${spelled}`);
		} else {
			functions.add(name);
		}
		return reasons;
	}
	if (word.expansion) return reasons; // already an error in repositoryCodeReasons
	if (name.includes("/")) {
		reasons.push(`runs ${name} through a path; ${describe} may run only bare allowlisted names looked up on PATH: ${spelled}`);
		return reasons;
	}
	if (functions.has(name) || DIRECTORY_COMMANDS.test(name)) return reasons; // cd/pushd are checked by credentialStepReasons
	if (!allowed.has(name)) {
		reasons.push(`runs ${name}, which is not on the command allowlist for ${describe} (${[...allowed].sort().join(", ")}): ${spelled}`);
		return reasons;
	}
	const args = words.slice(index + 1);
	const dashArtifacts = [...new Set(artifactDirectories)];
	// Every option name must be literal, whatever the tool: `--${x}`, `-$flag` (review round 7, finding 3).
	for (const arg of args) {
		if (optionNameExpands(arg)) reasons.push(`${name} option ${arg.text} is built from an expansion, so the checker cannot tell what it does: ${spelled}`);
	}
	const { reasons: optionReasons } = toolArguments(name, args, { artifactDirectories });
	for (const reason of optionReasons) reasons.push(`${reason}: ${spelled}`);
	if (name === "gh") {
		const sub = args[0];
		// A file gh reads and sends (release notes, a PR body, an API body) must be a downloaded
		// artifact spelled plainly, or a literal file under /tmp the job wrote itself (review round 6, finding 3).
		const fileArgument = (value, option) => {
			if (!value || value.expansion || !(isArtifactPath(value.text, artifactDirectories) || TMP_FILE.test(value.text))) {
				reasons.push(`gh ${option} must name a downloaded artifact (${dashArtifacts.join(", ") || "none"}) or a literal /tmp file, never ${value?.text ?? "nothing"}: ${spelled}`);
			}
		};
		const apiField = sub?.text === "api" ? /^(-F|--field)$/ : /^--field$/; // `-F` is --notes-file for gh release
		for (const [position, arg] of args.entries()) {
			if (arg.expansion && arg.text.startsWith("-")) continue; // optionNameExpands is reported above
			if (GH_FILE_OPTIONS.test(arg.text) && !apiField.test(arg.text)) fileArgument(args[position + 1], arg.text);
			const attached = arg.text.match(/^(--notes-file|--body-file|--input)=(.*)$/);
			if (attached) fileArgument({ text: attached[2], expansion: arg.expansion }, attached[1]);
			// `-F key=@file`, `--field key=@file`, `--field=key=@file` read a file into an API field.
			const field = apiField.test(arg.text) ? args[position + 1] : arg.text.match(/^--field=(.*)$/) ? { text: arg.text.slice("--field=".length), expansion: arg.expansion } : null;
			const at = field?.text.indexOf("=@") ?? -1;
			if (field && at !== -1) fileArgument({ text: field.text.slice(at + 2), expansion: field.expansion }, `${arg.text.split("=")[0]} key=@file`);
		}
		if (!sub || sub.expansion || !GH_SUBCOMMANDS.test(sub.text)) {
			reasons.push(`gh may only run ${GH_SUBCOMMANDS.source.slice(2, -2).replaceAll("|", ", ")} here; other subcommands (extension, alias, auth, config, run, ...) run code or move the token: ${spelled}`);
		} else if (sub.text === "release") {
			// Every option must be known so the checker can tell the release assets from option
			// values; every asset must be a downloaded artifact or `<artifact dir>/*`.
			const operation = args[1];
			const options = operation && !operation.expansion ? GH_RELEASE_OPTIONS[operation.text] : undefined;
			if (!options) {
				reasons.push(`gh release may only ${Object.keys(GH_RELEASE_OPTIONS).join(", ")} here; ${operation?.text ?? "nothing"} deletes, downloads or is not a literal: ${spelled}`);
			} else {
				const parsed = parseOptions(args, options, 2);
				const positionals = parsed.positionals.map((position) => args[position]);
				const assets = positionals.slice(1); // the first positional is the tag
				for (const asset of assets) {
					const glob = asset.text.endsWith("/*") && !asset.expansion && artifactDirectories.includes(asset.text.slice(0, -2)) && posix.normalize(asset.text.slice(0, -2)) === asset.text.slice(0, -2);
					if (!glob && !(!asset.expansion && isArtifactPath(asset.text, artifactDirectories))) {
						reasons.push(`gh release ${operation.text} may only attach downloaded artifacts (${dashArtifacts.map((directory) => `${directory}/*`).join(", ") || "none"}), never ${asset.text}: ${spelled}`);
					}
				}
				if (/^(view|list)$/.test(operation.text) && assets.length > 0) reasons.push(`gh release ${operation.text} takes no file: ${spelled}`);
				if (operation.text === "download") {
					// The published-asset reuse path: downloads may only land in a
					// downloaded-artifact directory, never the workspace root or a path
					// the step constructs.
					const option = parsed.options.find((candidate) => candidate.name === "--dir" || candidate.name === "-D");
					const target = option?.value && !option.value.expansion ? option.value.text : null;
					if (!target || !artifactDirectories.includes(target)) {
						reasons.push(`gh release download may only write into a downloaded-artifact directory (${dashArtifacts.join(", ") || "none"}), never ${target ?? "an expanded or missing path"}: ${spelled}`);
					}
				}
			}
		} else if (sub.text === "repo") {
			if (args[1]?.text !== "clone" || args[1].expansion) reasons.push(`gh repo may only clone here: ${spelled}`);
			const dash = args.findIndex((arg) => arg.text === "--" && !arg.expansion);
			if (dash !== -1) {
				const gitArgs = args.slice(dash + 1);
				for (let position = 0; position < gitArgs.length; position += 1) {
					const arg = gitArgs[position];
					if (!GH_CLONE_GIT_OPTIONS.test(arg.text) || arg.expansion) {
						reasons.push(`gh repo clone may hand git only --depth <n>; ${arg.text} could configure the clone to run code: ${spelled}`);
						break;
					}
					if (!/^[0-9]+$/.test(gitArgs[position + 1]?.text ?? "")) {
						reasons.push(`gh repo clone -- --depth needs a literal number: ${spelled}`);
						break;
					}
					position += 1;
				}
			}
		}
	}
	if (name === "git") {
		let position = 0;
		while (position < args.length && args[position].text.startsWith("-")) {
			const option = args[position];
			if (option.text === "-C" && !option.expansion && args[position + 1]) position += 2;
			else if (option.text === "-c" && !option.expansion && args[position + 1] && !args[position + 1].expansion && GIT_CONFIG_KEYS.test(args[position + 1].text)) position += 2;
			else {
				reasons.push(`git may carry only -C <dir> and -c user.name=/-c user.email= before its subcommand; ${option.text} could change what git runs: ${spelled}`);
				return reasons;
			}
		}
		const sub = args[position];
		if (!sub || sub.expansion || !GIT_COMMAND_OPTIONS[sub.text]) {
			reasons.push(`git may only run ${Object.keys(GIT_COMMAND_OPTIONS).join(", ")} here: ${spelled}`);
		}
		for (const arg of args.slice(position + 1)) {
			// Sharper than "not in the table" for the options that name a program or another configuration.
			if (GIT_FORBIDDEN_OPTIONS.test(arg.text) || /^--config/.test(arg.text)) reasons.push(`git option ${arg.text} names a program or another configuration to use: ${spelled}`);
		}
	}
	if (name === "tar") {
		if (args[0] && !args[0].text.startsWith("-")) reasons.push(`tar old-style option words (${args[0].text}) are not read by the checker; spell options with a dash: ${spelled}`);
		for (const arg of args) {
			if (TAR_FORBIDDEN_OPTIONS.test(arg.text)) reasons.push(`tar option ${arg.text} runs a program or reads a list the checker cannot see: ${spelled}`);
		}
		const parsed = parseOptions(args, TOOL_OPTIONS.tar);
		for (const option of parsed.options) {
			if ((option.name === "-C" || option.name === "--directory") && !(option.value && !option.value.expansion && (isArtifactDirectory(option.value.text, artifactDirectories) || TMP_FILE.test(option.value.text)))) {
				reasons.push(`tar may extract only into a downloaded artifact directory or a literal /tmp path, never ${option.value?.text ?? "nothing"}: ${spelled}`);
			}
		}
	}
	if (name === "curl") {
		let https = false;
		const parsed = parseOptions(args, TOOL_OPTIONS.curl);
		for (const option of parsed.options) {
			if (option.name === "--proto" && option.value && !option.value.expansion && option.value.text === "=https") https = true;
			if ((option.name === "-o" || option.name === "--output") && !(option.value && !option.value.expansion && (isArtifactPath(option.value.text, artifactDirectories) || TMP_FILE.test(option.value.text)))) {
				reasons.push(`curl may write only to a downloaded artifact path or a literal /tmp file, never ${option.value?.text ?? "nothing"}: ${spelled}`);
			}
		}
		for (const arg of args) {
			// Sharper than "not in the table" for the options that read a config or weaken TLS.
			if (CURL_FORBIDDEN_OPTIONS.test(arg.text)) reasons.push(`curl option ${arg.text} reads a config, weakens TLS or lets the server pick the output name: ${spelled}`);
		}
		const urls = parsed.positionals.map((position) => args[position]);
		if (urls.length === 0) reasons.push(`curl names no URL: ${spelled}`);
		for (const url of urls) {
			if (url.expansion || !/^https:\/\//.test(url.text)) reasons.push(`curl must fetch https:// URLs only, spelled literally, never ${url.text}: ${spelled}`);
		}
		if (!https) reasons.push(`curl must pin --proto '=https' in ${describe}: ${spelled}`);
	}
	if (name === "jq") {
		const parsed = parseOptions(args, TOOL_OPTIONS.jq);
		const program = parsed.positionals.map((position) => args[position])[0];
		if (!program || program.expansion) reasons.push(`jq must run a literal program written in the workflow file, never ${program?.text ?? "nothing"}: ${spelled}`);
	}
	if (name === "npm") {
		// Exactly `npm publish <tarball> --provenance --access public --ignore-scripts` (any order of
		// the options), or `npm --version`: no config, no registry, no script shell, no other subcommand.
		const texts = args.map((arg) => arg.text);
		const isVersion = texts.length === 1 && /^(--version|-v)$/.test(texts[0]);
		const rest = texts.slice(1);
		const tarball = args[1];
		const isPublish = texts[0] === "publish" && tarball && !tarball.text.startsWith("-") && texts.length === 2 + NPM_PUBLISH_OPTIONS.length && (() => {
			const expected = [...NPM_PUBLISH_OPTIONS].sort().join(" ");
			const after = rest.slice(1);
			// `--access public` must stay adjacent: the value is a positional otherwise.
			const access = after.indexOf("--access");
			return after[access + 1] === "public" && [...after].sort().join(" ") === expected;
		})();
		if (!isVersion && !isPublish) {
			reasons.push(`npm may only run 'npm publish <tarball> ${NPM_PUBLISH_OPTIONS.join(" ")}' or 'npm --version' here: ${spelled}`);
		}
	}
	if (WRITING_COREUTILS[name]) {
		// None of these takes an option with a value; every option must be literal and listed.
		const parsed = parseOptions(args, {});
		const tool = WRITING_COREUTILS[name];
		for (const arg of parsed.unknown) {
			if (!tool.options.test(arg.text)) reasons.push(`${name} option ${arg.text} is not one the checker allows here (${tool.options.source}): ${spelled}`);
		}
		// A downloaded artifact directory is read, verified and uploaded; nothing may be created,
		// renamed or deleted in it, or the uploaded set is no longer what verify saw (review round 7).
		const positionals = parsed.positionals.map((position) => args[position]);
		const targets = tool.targets === "last" ? positionals.slice(-1) : tool.targets === "all" ? positionals : [];
		for (const target of targets) {
			// A literal target is the path it spells; an expanded one is resolved through the values
			// the step has bound, so `cp /tmp/evil "$file"` after `for file in <artifact dir>/*`
			// writes into the directory the job uploads (review round 8, finding 4). Both also resolve
			// against the working directory the step has `cd`-ed into, exactly like a redirection
			// target (review round 9, finding 5). A target whose value the checker cannot pin is not
			// provably an artifact, so only the provable case is an error here; a REDIRECTION to one
			// is refused outright in expansionReasons.
			const lands = writeTargetLands(target, values, { artifactDirectories, cwd });
			if (lands.class === "artifact") reasons.push(`${name} writes into a downloaded artifact directory (${dashArtifacts.join(", ")}), which the job uploads as verified: ${spelled}`);
			// Round 9, finding 5: the scratch rule reads the RESOLVED landing - after the working
			// directory and any binding - never the raw word, so `cp /tmp/evil "$target"` with
			// target=/usr/local/bin/x writes outside /tmp exactly like the spelled-out path.
			if (writesOutsideScratch(lands.resolved ?? target.text)) reasons.push(`${name} writes outside /tmp: a profile, a binary on PATH or a tool's configuration could be replaced: ${spelled}`);
		}
	}
	return reasons;
}

/** True when a path is a downloaded artifact directory, or lies inside one. */
function touchesArtifacts(text, artifactDirectories) {
	return isArtifactPath(text, artifactDirectories) || isArtifactDirectory(text, artifactDirectories);
}
/** True when a literal absolute path is outside the scratch locations a credential-bearing step may write (`/tmp/...`, `/dev/...`). */
function writesOutsideScratch(text) {
	return text.startsWith("/") && !/^\/(tmp|dev)\//.test(text);
}

/**
 * Parses the arguments of an allowlisted tool against its option table(s) (see {@link TOOL_OPTIONS},
 * {@link GIT_COMMAND_OPTIONS}, {@link GH_RELEASE_OPTIONS}, {@link AWS_OPTIONS}). Returns the indices of the
 * words that are option values, the index after a literal `--`, and the reasons an option or
 * subcommand is not allowed. {@link expansionReasons} uses the value slots; {@link commandAllowlistReasons}
 * reports the reasons.
 */
export function toolArguments(name, args, { artifactDirectories = [] } = {}) {
	const reasons = [];
	const result = (parsed, tool) => {
		for (const arg of parsed.unknown) reasons.push(`${tool} carries an option the checker does not know, so it cannot tell which words are values and which are files: ${arg.text}`);
		return { values: parsed.values, rest: parsed.rest, positionals: parsed.positionals, reasons };
	};
	const none = () => ({ values: new Set(), rest: -1, positionals: args.map((_, position) => position), reasons });
	const literal = (word) => word && !word.expansion ? word.text : null;
	switch (name) {
		case "jq":
		case "tar":
		case "curl":
			return result(parseOptions(args, TOOL_OPTIONS[name]), name);
		case "cosign":
		case "syft": {
			const table = TOOL_OPTIONS[name][literal(args[0])];
			if (!table) {
				reasons.push(`${name} may only run ${Object.keys(TOOL_OPTIONS[name]).join(", ")} here, never ${args[0]?.text ?? "nothing"}`);
				return none();
			}
			return result(parseOptions(args, table, 1), `${name} ${args[0].text}`);
		}
		case "gh": {
			const sub = literal(args[0]);
			if (sub === "api") return result(parseOptions(args, TOOL_OPTIONS["gh api"], 1), "gh api");
			if (sub === "release") {
				const table = GH_RELEASE_OPTIONS[literal(args[1])];
				return table ? result(parseOptions(args, table, 2), `gh release ${args[1].text}`) : none(); // the subcommand error is reported by the caller
			}
			if (sub === "pr") {
				const table = TOOL_OPTIONS["gh pr"][literal(args[1])];
				if (!table) {
					reasons.push(`gh pr may only ${Object.keys(TOOL_OPTIONS["gh pr"]).join(", ")} here, never ${args[1]?.text ?? "nothing"}`);
					return none();
				}
				return result(parseOptions(args, table, 2), `gh pr ${args[1].text}`);
			}
			if (sub === "repo") return result(parseOptions(args, {}, 2), "gh repo clone");
			return none();
		}
		case "git": {
			const values = new Set();
			let position = 0;
			while (position < args.length && args[position].text.startsWith("-")) {
				if (/^-[Cc]$/.test(args[position].text) && !args[position].expansion) values.add(position + 1);
				position += 2;
			}
			const table = GIT_COMMAND_OPTIONS[literal(args[position])];
			if (!table) return { values, rest: -1, positionals: [], reasons }; // the subcommand error is reported by the caller
			const parsed = parseOptions(args, table, position + 1);
			for (const value of parsed.values) values.add(value);
			return { ...result(parsed, `git ${args[position].text}`), values };
		}
		case "aws": {
			const service = literal(args[0]);
			const operation = literal(args[1]);
			const table = service && operation ? AWS_OPTIONS[service === "s3api" ? "s3api" : `${service} ${operation}`] : undefined;
			if (!table) return none(); // reported by r2StepReasons
			const parsed = parseOptions(args, table, 2);
			return { values: parsed.values, rest: parsed.rest, positionals: parsed.positionals, reasons }; // unknown options are reported by r2StepReasons
		}
		case "npm":
			return { ...none(), values: new Set(args.flatMap((arg, position) => (arg.text === "--access" && !arg.expansion ? [position + 1] : []))) };
		case "printf": {
			// After a literal format string every argument is data: printf stops reading options there.
			if (args[0] && !args[0].expansion && !args[0].text.startsWith("-")) return { values: new Set(args.map((_, position) => position).slice(1)), rest: -1, positionals: [0], reasons };
			return none();
		}
		default: {
			// No option table: nothing is a value slot, but a literal `--` still ends the options.
			const parsed = parseOptions(args, {});
			return { values: new Set(), rest: parsed.rest, positionals: parsed.positionals, reasons };
		}
	}
}

/**
 * Returns the reasons a simple command in a credential-bearing job expands something the checker
 * cannot pin down (review round 7, finding 3). `state` is `{ bound, prefixed, functions }`, the
 * variables the step has bound so far, those whose value provably begins with a literal that is
 * not `-`, and the functions it has defined; the walk in {@link credentialStepReasons} feeds it.
 *   - Every variable an argument or redirection target expands must be on {@link ALLOWED_VARIABLES}
 *     (or set by the runner) and bound earlier in the step; `${!x}`, `${x@P}` and an assignment
 *     inside `$(( ))` are refused outright.
 *   - A word that begins with an expansion is an option if the value begins with `-`, so in the
 *     argument list of anything but an {@link EXPANSION_SAFE_COMMANDS} command or a shell function
 *     it must be the value slot of a known option, follow a literal `--`, or begin with a variable
 *     whose value provably does not begin with `-` (a `for` over `<artifact dir>/*`, an assignment
 *     from a literal, a runner variable).
 *   - The assigning builtins (`export`, `local`, `read`, `printf -v`, ...) must name the variable literally.
 *   - Nothing may be written to `$GITHUB_ENV`, `$GITHUB_PATH` or into a downloaded artifact directory.
 * The command's own assignments are then bound for what follows.
 */
export function expansionReasons(input, state, { artifactDirectories = [], cwd = "" } = {}) {
	const command = asCommand(input);
	const reasons = [];
	const spelled = command.words.map((word) => word.text).join(" ");
	for (const substitution of command.substitutions) {
		for (const inner of shellCommands(substitution)) {
			for (const reason of expansionReasons(inner, state, { artifactDirectories, cwd })) reasons.push(`inside a command substitution: ${reason}`);
		}
	}
	const check = (text, where) => {
		const { names, reasons: inner } = variableReferences(text);
		for (const reason of inner) reasons.push(`${reason} (${where})`);
		for (const name of new Set(names)) {
			if (!ALLOWED_VARIABLES.includes(name) && !GITHUB_DEFAULT_ENV.includes(name)) {
				reasons.push(`expands $${name}, which is not on the variable allowlist for credential-bearing jobs (${where})`);
			} else if (!state.bound.has(name)) {
				reasons.push(`expands $${name} before this step binds it, so its value would come from the environment (${where})`);
			}
		}
	};
	for (const word of command.words) {
		if (word.expansion) check(word.text, spelled);
		if (word.nul) reasons.push(`a word contains a NUL character, which truncates it in ways the checker does not follow: ${spelled}`);
	}
	for (const redirection of command.redirections) {
		const target = `${redirection.operator}${redirection.text} (${spelled})`;
		if (redirection.expansion) check(redirection.text, target);
		if (STEP_STATE_FILES.test(redirection.text)) reasons.push(`writes to a file that sets the environment or PATH of every later step: ${target}`);
		if (/^[0-9]*(>>|>\||>|&>>|&>|<>)$/.test(redirection.operator)) {
			// Where the target lands, literal or expanded: a redirection may never write into a
			// downloaded artifact directory, and an expanded target has to provably avoid one - the
			// step's own bindings decide (`printf x > "$file"` after `for file in <artifact dir>/*`,
			// review round 8, finding 4). A literal target resolves against the working directory
			// the step has `cd`-ed into; an unknown one fails closed.
			const lands = writeTargetLands(redirection, state.values, { artifactDirectories, cwd });
			if (lands.class === "artifact") reasons.push(`writes into a downloaded artifact directory, which the job uploads as verified: ${target}`);
			else if (lands.class === "unknown") reasons.push(`redirects to a target the checker cannot resolve, so it cannot prove it stays out of the downloaded artifact directories: ${target}`);
			else if (writesOutsideScratch(lands.resolved ?? redirection.text)) reasons.push(`writes outside /tmp: a profile, a binary on PATH or a tool's configuration could be replaced: ${target}`);
		}
	}
	if (command.casePattern || command.heredoc) return reasons; // data; bound nothing
	const index = commandIndex(command.words);
	if (index !== -1) {
		const name = command.words[index].text;
		const args = command.words.slice(index + 1);
		const leadsWithExpansion = (arg) => arg.expansion && /^[$`]/.test(arg.text);
		if (name === "printf") {
			// `printf -v NAME` assigns; the name must be literal. Everything after a literal format is data.
			for (const [position, arg] of args.entries()) {
				const target = arg.text === "-v" && !arg.expansion ? args[position + 1] : /^-v./.test(arg.text) && !arg.expansion ? null : undefined;
				if (target !== undefined && (target === null ? false : !target || leadsWithExpansion(target))) reasons.push(`printf -v names what it assigns through an expansion, so the checker cannot tell which variable is set: ${spelled}`);
			}
		}
		if (ASSIGNING_COMMANDS.test(name) && name !== "printf") {
			for (const arg of args) {
				if (leadsWithExpansion(arg)) reasons.push(`${name} names what it assigns through an expansion, so the checker cannot tell which variable is set: ${spelled}`);
			}
		} else if (!EXPANSION_SAFE_COMMANDS.test(name) && !state.functions.has(name) && !DIRECTORY_COMMANDS.test(name) && !command.words[index].expansion) {
			const { values, rest } = toolArguments(name, args, { artifactDirectories });
			for (const [position, arg] of args.entries()) {
				if (!leadsWithExpansion(arg) || values.has(position) || (rest !== -1 && position >= rest)) continue;
				if (beginsSafely(arg.text, state.prefixed)) continue;
				reasons.push(`${name} receives ${arg.text} where an option could stand; an expanded word must be the value of a known option, follow a literal --, or begin with a variable whose value provably does not begin with '-': ${spelled}`);
			}
		}
	}
	bindVariables(command, state, { artifactDirectories });
	return reasons;
}

/**
 * Where a `$(mktemp ...)` invocation's file lands (review round 9, finding 4). Scratch is provable
 * only when the file is under /tmp or $RUNNER_TEMP: a bare `mktemp`, `--tmpdir`/`-t` without a
 * directory, or a template (or `-p DIR`) that spells such a path. A template in a downloaded
 * artifact directory is an artifact write; any other template, directory or option the helper does
 * not recognise is `unknown`, which the target checks refuse.
 */
function mktempClass(inner, values, artifactDirectories) {
	// Parse the invocation the way the shell would, so quoting does not hide the template.
	const parsed = splitWords(`mktemp ${inner}`);
	if (parsed.unterminated) return { class: "unknown", literal: null };
	const command = parsed.commands.find((entry) => entry.words[0]?.text === "mktemp");
	if (!command) return { class: "unknown", literal: null };
	const words = command.words.slice(1).map((word) => word.text);
	let directory = null; // null: no -p/--tmpdir/-t, so a bare template names a file in the working directory
	let template = null;
	for (let position = 0; position < words.length; position += 1) {
		const word = words[position];
		if (word === "--") {
			template = words.slice(position + 1).at(-1) ?? template;
			break;
		}
		if (word === "-p" || word === "--tempdir" || word === "--tmpdir") {
			// The directory may be the next word; without one mktemp falls back to $TMPDIR (/tmp).
			const next = words[position + 1];
			if (word === "-p" && next !== undefined && !next.startsWith("-")) {
				directory = next;
				position += 1;
			} else directory = "/tmp";
			continue;
		}
		if (/^--(tempdir|tmpdir)=/.test(word)) {
			directory = word.slice(word.indexOf("=") + 1);
			continue;
		}
		if (word === "-t") {
			directory = "/tmp"; // the template is interpreted relative to the temp directory
			continue;
		}
		if (/^(-d|--directory|-q|--quiet)$/.test(word) || /^--suffix=/.test(word)) continue;
		if (/^-[a-z]+$/.test(word) && /^[dq]*$/.test(word.slice(1))) continue;
		if (word.startsWith("-")) return { class: "unknown", literal: null }; // an option this helper does not model
		template = word;
	}
	// Where the file lands: scratch is provable only under /tmp or $RUNNER_TEMP; a template in a
	// downloaded artifact directory is an artifact write; everything else the caller refuses.
	const landing =
		directory !== null
			? valueClassOf(`${directory}/${template ?? "tmp.XXXXXXXXXX"}`, values, artifactDirectories)
			: template === null
				? { class: "scratch" } // a bare mktemp: /tmp/tmp.XXXXXXXXXX
				: valueClassOf(template, values, artifactDirectories);
	if (landing.class === "scratch" || landing.class === "artifact") return { class: landing.class, literal: null };
	return { class: "unknown", literal: null };
}

/**
 * Where a value a command assigns provably lands, for the redirection and writing-coreutils target
 * checks (review round 8, finding 4): "artifact" (inside a downloaded artifact directory),
 * "scratch" (a literal /tmp path, under $RUNNER_TEMP, or a mktemp the checker has proven stays
 * under them - round 9, finding 4), "outside" (provably not inside the artifact directories) or
 * "unknown" (the checker cannot pin it). `literal` is the value when it is spelled out in full,
 * so an absolute path outside /tmp is still refused. A `$GITHUB_WORKSPACE` prefix is classified by
 * its literal suffix: the workspace is the parent of the downloaded artifact directories, so
 * `$GITHUB_WORKSPACE/<artifact dir>/...` is an artifact write; anything else the checker cannot
 * pin stays "unknown", never "outside" (round 9, finding 3).
 */
function valueClassOf(text, values, artifactDirectories) {
	const value = String(text);
	if (!/[$`]/.test(value)) {
		if (isArtifactPath(value, artifactDirectories) || isArtifactDirectory(value, artifactDirectories)) return { class: "artifact", literal: value };
		return { class: TMP_FILE.test(value) ? "scratch" : "outside", literal: value };
	}
	// "$RUNNER_TEMP/x": the runner's scratch directory, with a literal file name under it.
	const temp = value.match(/^\$\{?RUNNER_TEMP\}?\/([^$/`]*)$/);
	if (temp && temp[1] !== "" && !hasDotSegment(value)) return { class: "scratch", literal: null };
	// "$(mktemp ...)": mktemp creates its file where its template says, which is provable
	// scratch only under /tmp or $RUNNER_TEMP (round 9, finding 4).
	const mktemp = value.match(/^\$\(\s*mktemp\b([\s\S]*)\)\s*$/);
	if (mktemp) return mktempClass(mktemp[1], values, artifactDirectories);
	// A single variable, or a variable a literal suffix hangs on: wherever its binding lands.
	const lead = value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(.*)$/s);
	if (lead) {
		if (GITHUB_DEFAULT_ENV.includes(lead[1])) {
			// Round 9, finding 3: `$GITHUB_WORKSPACE` is the parent of the downloaded artifact
			// directories, so its literal suffix decides; the suffix is never spelled more
			// provably than the directories themselves, and anything else stays unknown.
			if (lead[1] === "GITHUB_WORKSPACE") {
				const suffix = lead[2].replace(/^\//, "");
				if (lead[2] !== "" && !hasDotSegment(lead[2]) && (isArtifactPath(suffix, artifactDirectories) || isArtifactDirectory(suffix, artifactDirectories)))
					return { class: "artifact", literal: null };
				return { class: "unknown", literal: null };
			}
			return { class: lead[1] === "RUNNER_TEMP" ? "scratch" : "outside", literal: null };
		}
		const known = values?.get(lead[1]);
		if (!known) return { class: "unknown", literal: null };
		if (known.class === "artifact") return { class: "artifact", literal: null };
		// A known literal value plus the suffix is still a literal the checker can read.
		if (known.literal !== null) return valueClassOf(`${known.literal}${lead[2]}`, values, artifactDirectories);
		return { class: known.class, literal: null };
	}
	return { class: "unknown", literal: null };
}

/**
 * Where a write target lands: "artifact", "scratch", "outside" or "unknown", plus the resolved
 * literal when there is one (review round 8, finding 4). A literal target also resolves against the
 * working directory the step has `cd`-ed into, so `cd artifacts && printf x > SHA256SUMS` writes
 * into the uploaded directory too. An expanded target is resolved through the values the step has
 * bound (`printf x > "$file"` after `for file in <artifact dir>/*`) and its literal value - when
 * the checker can read one - resolves against that same working directory (round 9, finding 3):
 * `cd artifacts && printf x > "$file"` with file=SHA256SUMS writes into the uploaded directory
 * too. `scratch` and `outside` are provably not a verified artifact, `unknown` is not provably
 * anything.
 */
function writeTargetLands(word, values, { artifactDirectories, cwd = "" } = {}) {
	if (!word.expansion) {
		const resolved = resolveAgainst(cwd, word) ?? word.text;
		return { class: touchesArtifacts(resolved, artifactDirectories) ? "artifact" : "outside", resolved };
	}
	const value = valueClassOf(word.text, values, artifactDirectories);
	if (value.literal === null) return { class: value.class, resolved: null };
	// Round 9, finding 3: an expanded target with a literal value resolves against the working
	// directory exactly like a literal one, so `cd <artifact dir> && printf x > "$file"` with
	// file=SHA256SUMS is caught; the class stays what the value said unless the resolution makes
	// the artifact write provable.
	const resolved = resolveAgainst(cwd, { text: value.literal, expansion: false }) ?? value.literal;
	return { class: touchesArtifacts(resolved, artifactDirectories) ? "artifact" : value.class, resolved };
}

/** Binds what a command assigns into `state.bound`, tracks which of those values provably begin with a literal that is not `-`, and where each value lands (review round 8, finding 4). */
function bindVariables(command, state, { artifactDirectories = [] } = {}) {
	const words = command.words;
	const assignedHere = assignedNames(command);
	for (const name of assignedHere) {
		state.bound.add(name);
		state.prefixed.delete(name);
	}
	const prefixedValue = (text) => beginsSafely(text, state.prefixed) && !text.startsWith("(");
	// `X=value` words, wherever assignedNames found them.
	for (const word of words) {
		const match = word.text.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=(.*)$/s);
		if (match && assignedHere.includes(match[1]) && !match[2] && prefixedValue(match[3])) state.prefixed.add(match[1]);
	}
	// Where every assigned value lands; a name assigned without a value (`read x`, a bare `local x`)
	// is unknown, and so is an array element or anything the checker cannot read.
	for (const name of new Set(assignedHere)) {
		let assigned = null;
		for (const word of words) {
			const match = word.text.match(new RegExp(`^${name}(\\[[^\\]]*\\])?\\+?=([\\s\\S]*)$`));
			if (match && !match[1]) assigned = match[2];
		}
		state.values.set(name, assigned === null ? { class: "unknown", literal: null } : valueClassOf(assigned, state.values, artifactDirectories));
	}
	// `for X in a b c`: prefixed when every item is, and wherever the items land.
	const texts = words.map((word) => word.text);
	const at = texts.findIndex((text) => /^(for|select)$/.test(text));
	if (at !== -1 && texts[at + 2] === "in" && words[at + 1]) {
		const items = words.slice(at + 3).filter((word) => !/^(do|;)$/.test(word.text));
		if (items.length > 0 && items.every((item) => prefixedValue(item.text))) state.prefixed.add(words[at + 1].text);
		if (items.length > 0) {
			const classes = items.map((item) => valueClassOf(item.text, state.values, artifactDirectories).class);
			const combined = classes.includes("artifact")
				? "artifact"
				: classes.every((entry) => entry === "scratch" || entry === "outside")
					? (classes.includes("scratch") ? "scratch" : "outside")
					: "unknown";
			state.values.set(words[at + 1].text, { class: combined, literal: null });
		}
	}
}

/**
 * True when `--ignore-scripts` is enabled on a package-manager command line and never disabled:
 * bare, `--ignore-scripts=true` or `--ignore-scripts true`. `--ignore-scripts=false`,
 * `--ignore-scripts false`, `--no-ignore-scripts` or any other value disables it, whatever else
 * the line says.
 */
export function ignoreScriptsEnabled(args) {
	const texts = args.map((arg) => (typeof arg === "string" ? arg : arg.text));
	let enabled = false;
	for (const [index, text] of texts.entries()) {
		if (text === "--no-ignore-scripts") return false;
		if (text.startsWith("--ignore-scripts=")) {
			if (text !== "--ignore-scripts=true") return false;
			enabled = true;
		} else if (text === "--ignore-scripts") {
			const next = texts[index + 1];
			if (next === "false") return false;
			if (next !== undefined && next !== "true" && /^(true|false|0|1|yes|no|on|off)$/i.test(next)) return false;
			enabled = true;
		}
	}
	return enabled;
}

/**
 * Returns the reasons a simple command on a build runner would run dependency lifecycle scripts.
 * `location` is `{ workflow, jobId }`; the literal `npm rebuild esbuild` is allowed only where
 * REBUILD_ALLOWLIST says so.
 */
export function lifecycleReasons(input, location = {}) {
	const command = asCommand(input);
	const reasons = [];
	for (const substitution of command.substitutions) {
		for (const inner of shellCommands(substitution)) {
			for (const reason of lifecycleReasons(inner, location)) reasons.push(`inside a command substitution: ${reason}`);
		}
	}
	const wrapperReasons = [];
	const index = commandIndex(command.words, wrapperReasons);
	if (index === -1) return reasons;
	const commandWord = command.words[index];
	const spelledAll = command.words.map((word) => word.text).join(" ");
	// `"$manager" ci`, `"${m}m" install`: the checker cannot tell whether a package manager runs, so
	// no expansion may stand in command position anywhere in a build workflow (review round 6, finding 4).
	if (commandWord.expansion) {
		reasons.push(`the command is a shell expansion, so the checker cannot tell whether it is a package manager: ${spelledAll}`);
		return reasons;
	}
	for (const reason of wrapperReasons) reasons.push(`${reason} (${spelledAll})`);
	const name = posix.basename(commandWord.text);
	const args = command.words.slice(index + 1);
	const spelled = command.words.slice(index).map((word) => word.text).join(" ");
	const isDlx = /^(pnpm|yarn)$/.test(name) && args[0]?.text === "dlx" && !args[0].expansion;
	if (PACKAGE_EXECUTORS.test(name) || isDlx) {
		// The child command: the first word after a literal `--`, else the first word that names a
		// package manager (`npm`, `npm@10` under corepack) or an interpreter. Its arguments are the rest.
		if (name === "corepack" && args[0] && !args[0].expansion && COREPACK_SUBCOMMANDS.test(args[0].text)) return reasons; // downloads a package manager, runs nothing
		const dash = args.findIndex((arg) => arg.text === "--" && !arg.expansion);
		const childName = (arg) => (PACKAGE_MANAGERS.test(arg.text.replace(/@.*$/, "")) ? arg.text.replace(/@.*$/, "") : arg.text); // `npm@10`, `pnpm@9.1.0`
		let childAt = dash !== -1 ? dash + 1 : args.findIndex((arg, position) => position >= (isDlx ? 1 : 0) && !arg.expansion && (PACKAGE_MANAGERS.test(childName(arg)) || (INTERPRETERS.test(arg.text) && dash === -1)));
		if (dash !== -1 && childAt >= args.length) childAt = -1;
		if (args.slice(0, childAt === -1 ? args.length : childAt).some((arg) => arg.expansion)) {
			reasons.push(`${name} carries an expansion before its child command, so the checker cannot tell what runs: ${spelled}`);
		}
		if (childAt !== -1) {
			const child = args[childAt];
			const childCommand = { ...command, words: [{ ...child, text: childName(child) }, ...args.slice(childAt + 1)], substitutions: [] };
			for (const reason of lifecycleReasons(childCommand, location)) reasons.push(`through ${name}: ${reason}`);
			if (PACKAGE_MANAGERS.test(childName(child)) && name !== "corepack") {
				reasons.push(`${name} runs a package manager (${childName(child)}); run it directly so its flags are the ones the checker reads: ${spelled}`);
			}
		} else if (name === "corepack") {
			if (!args[0] || args[0].expansion || !COREPACK_SUBCOMMANDS.test(args[0].text)) reasons.push(`corepack may only ${COREPACK_SUBCOMMANDS.source.slice(2, -2).replaceAll("|", ", ")} here; ${args[0]?.text ?? "nothing"} is not a corepack subcommand the checker knows: ${spelled}`);
		} else if (name !== "npx" && !isDlx) {
			reasons.push(`${name} runs a child command the checker could not find, so it cannot apply the package-manager rules: ${spelled}`);
		}
		if (name !== "npx" && !isDlx) return reasons;
	}
	if (!PACKAGE_MANAGERS.test(name)) return reasons;
	if (commandWord.text !== name) {
		reasons.push(`invokes ${name} through a path or expansion: ${spelled}`);
		return reasons;
	}
	if (ALWAYS_LIFECYCLE.test(name)) {
		reasons.push(`${name} installs and runs code from a registry, which the checker cannot allow on a release runner: ${spelled}`);
		return reasons;
	}
	if (name === "npx") {
		if (!ignoreScriptsEnabled(args)) reasons.push(`npx may install and run a package's lifecycle scripts; pass --ignore-scripts: ${spelled}`);
		return reasons;
	}
	const subcommands = LIFECYCLE_SUBCOMMANDS[name];
	if (!subcommands) return reasons; // corepack: downloads a package manager, runs no lifecycle script
	// The subcommand is the first word. An option before it (`npm --prefix x install`) may or may
	// not consume the next word, so the checker could not tell which command runs; refuse it.
	const sub = args[0];
	if (sub && sub.text.startsWith("-") && !INTERPRETER_INFO_FLAGS.test(sub.text)) {
		reasons.push(`${name} carries options before its subcommand, so the checker cannot tell which command runs: ${spelled}`);
		return reasons;
	}
	if (sub?.expansion) {
		reasons.push(`${name} runs a subcommand built from an expansion the checker cannot see: ${spelled}`);
		return reasons;
	}
	const subText = sub?.text ?? "";
	if (!subcommands.test(subText)) return reasons;
	if (name === "npm" && /^(rebuild|rb)$/.test(subText)) {
		const allowedJobs = REBUILD_ALLOWLIST.jobs[location.workflow] ?? [];
		const literal = [name, ...args.map((arg) => arg.text)].join(" ") === REBUILD_ALLOWLIST.command.join(" ");
		if (!literal || !allowedJobs.includes(location.jobId)) {
			reasons.push(`npm rebuild runs install scripts; only the literal '${REBUILD_ALLOWLIST.command.join(" ")}' is allowed, and only in ${Object.entries(REBUILD_ALLOWLIST.jobs).map(([workflow, jobs]) => `${workflow} (${jobs.join(", ")})`).join(" and ")}: ${spelled}`);
		}
		return reasons;
	}
	if (!ignoreScriptsEnabled(args)) {
		reasons.push(`${name} ${subText} runs dependency lifecycle scripts without --ignore-scripts: ${spelled}`.replace("  ", " "));
	}
	return reasons;
}

/**
 * Interpreter entry points of a package manager: `node /usr/lib/node_modules/npm/bin/npm-cli.js ci`
 * runs `npm ci` without ever spelling `npm` in command position.
 */
const PACKAGE_MANAGER_ENTRYPOINTS = /(^|\/)(npm-cli\.[cm]?js|npx-cli\.[cm]?js|npm|npx|yarn(\.[cm]?js)?|pnpm(\.[cm]?js)?|bun|bunx|corepack(\.[cm]?js)?|pip3?|uv|uvx)$|\/node_modules\/(npm|npx|yarn|pnpm|corepack|\.bin)\//;

/**
 * True when every variable reference in `text` is one the runner itself provides
 * ({@link GITHUB_DEFAULT_ENV}). In a BUILD job such a reference can only name runner state, never a
 * file or value derived from the repository, so inline code like
 * `node -p require('$RUNNER_TEMP/standalone-source/package.json').version` stays analyzable enough
 * for the build rules. Anything else - a repository- or step-derived variable - keeps the
 * conservative refusal.
 */
function runnerVariablesOnly(text) {
	const names = [...text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
	return names.length > 0 && names.every((name) => GITHUB_DEFAULT_ENV.includes(name));
}

/**
 * Returns the reasons a simple command on a build runner runs an interpreter in a way the checker
 * cannot follow (review round 6, finding 6). Build jobs legitimately run repository code through
 * node, sh and python3, so the rule is narrower than in credential-bearing jobs: the interpreter
 * must be a bare name (no `/usr/bin/node`), every option and the script it runs must be literal
 * (no `node "$dir"/publish.mjs`, `node -e "$CODE"`, `python3 -m "$MOD"`), the script must not be a
 * package manager's own entry point, and it may not read its program from a pipe or stdin. A
 * literal `sh -c '...'` string is re-parsed and held to the same rules; every OTHER interpreter's
 * inline code (`node -e`/`-p`/`--eval`/`--print`, `python3 -c`, ...) is refused outright, because
 * the checker cannot re-parse it (review round 9, finding 2).
 */
export function buildStepReasons(input, location = {}) {
	const command = asCommand(input);
	const reasons = [];
	for (const substitution of command.substitutions) {
		for (const inner of shellCommands(substitution)) {
			for (const reason of buildStepReasons(inner, location)) reasons.push(`inside a command substitution: ${reason}`);
		}
	}
	const index = commandIndex(command.words);
	if (index === -1) return reasons;
	const commandWord = command.words[index];
	if (commandWord.expansion) return reasons; // reported by lifecycleReasons
	const name = posix.basename(commandWord.text);
	if (!INTERPRETERS.test(name)) return reasons;
	const spelled = command.words.slice(index).map((word) => word.text).join(" ");
	if (commandWord.text !== name) {
		reasons.push(`runs ${name} through a path, so PATH pinning and the package-manager rules do not see it: ${spelled}`);
	}
	if (command.piped) reasons.push(`${name} reads its program from a pipe the checker cannot see: ${spelled}`);
	for (const redirection of command.redirections) {
		if (/^(<|<<|<<-|<<<)$/.test(redirection.operator)) reasons.push(`${name} reads its program from ${redirection.operator}${redirection.text}, which the checker cannot follow: ${spelled}`);
	}
	const args = command.words.slice(index + 1);
	const inlineFlag = INLINE_CODE_FLAGS[name];
	for (const [position, arg] of args.entries()) {
		if (arg.text === "-") {
			reasons.push(`${name} reads its program from stdin, which the checker cannot see: ${spelled}`);
			break;
		}
		if (arg.text === "--") {
			const script = args[position + 1];
			if (script?.expansion) reasons.push(`${name} runs a script named by an expansion the checker cannot resolve: ${spelled}`);
			else if (script && PACKAGE_MANAGER_ENTRYPOINTS.test(script.text)) reasons.push(`${name} runs a package manager's entry point, bypassing the package-manager rules: ${spelled}`);
			break;
		}
		if (arg.text.startsWith("-")) {
			if (arg.expansion) {
				reasons.push(`${name} carries an option built from an expansion the checker cannot see: ${spelled}`);
				break;
			}
			if (inlineFlag?.test(arg.text) || (SHELLS.test(name) && arg.text === "-c")) {
				const code = args[position + 1];
				if (!code) reasons.push(`${name} ${arg.text} names no inline code: ${spelled}`);
				else if (code.expansion && !runnerVariablesOnly(code.text))
					reasons.push(`${name} ${arg.text} runs code from an expansion the checker cannot see: ${spelled}`);
				else if (SHELLS.test(name) && !code.expansion) {
					for (const inner of shellCommands(code.text)) {
						for (const reason of [...lifecycleReasons(inner, location), ...buildStepReasons(inner, location)]) reasons.push(`inside ${name} -c: ${reason}`);
					}
				} else if (!SHELLS.test(name)) {
					// Round 9, finding 2: only a shell's -c body is re-parsed above. Any other
					// interpreter's inline code - literal or runner-variable-only - is code this walk
					// cannot inspect, so it is refused instead of trusted.
					reasons.push(`${name} ${arg.text} runs inline code the checker cannot inspect: ${spelled}`);
				}
				break;
			}
			continue;
		}
		// The first positional argument is the script; what follows is its data. `deno eval
		// '<code>'` spells its inline code as a subcommand instead of a flag, so it is caught here
		// too (round 9, finding 2).
		if (name === "deno" && arg.text === "eval") reasons.push(`${name} eval runs inline code the checker cannot inspect: ${spelled}`);
		else if (arg.expansion) reasons.push(`${name} runs a script named by an expansion the checker cannot resolve: ${spelled}`);
		else if (PACKAGE_MANAGER_ENTRYPOINTS.test(arg.text)) reasons.push(`${name} runs a package manager's entry point, bypassing the package-manager rules: ${spelled}`);
		else if (hasDotSegment(arg.text) && !arg.text.startsWith("./")) reasons.push(`${name} runs a script through a . or .. segment: ${spelled}`);
		break;
	}
	return reasons;
}

/**
 * The shell variables a simple command assigns: `X=1 cmd`, `for X in`, `read X`, `local X=`,
 * `export X`, `printf -v X`, and an assignment handed to a wrapper - `env X=1 cmd`,
 * `sudo -E X=1 cmd` - which reaches cmd exactly like a prefix does (review round 6, finding 2).
 */
function assignedNames(command) {
	const names = [];
	const words = command.words;
	let index = 0;
	while (index < words.length && (ASSIGNMENT.test(words[index].text) || SHELL_KEYWORDS.test(words[index].text))) {
		if (ASSIGNMENT.test(words[index].text)) names.push(words[index].text.match(/^[A-Za-z_][A-Za-z0-9_]*/)[0]);
		if (/^(for|select)$/.test(words[index].text) && words[index + 1]) names.push(words[index + 1].text);
		index += 1;
	}
	const commandAt = commandIndex(words);
	for (const word of words.slice(index, commandAt === -1 ? words.length : commandAt)) {
		if (ASSIGNMENT.test(word.text)) names.push(word.text.match(/^[A-Za-z_][A-Za-z0-9_]*/)[0]);
	}
	if (commandAt !== -1 && ASSIGNING_COMMANDS.test(words[commandAt].text)) {
		for (const arg of words.slice(commandAt + 1)) {
			if (arg.text.startsWith("-")) {
				// `printf -vNAME` attaches the variable to the option.
				const attached = words[commandAt].text === "printf" ? arg.text.match(/^-v([A-Za-z_][A-Za-z0-9_]*)/) : null;
				if (attached && !arg.expansion) names.push(attached[1]);
				continue;
			}
			const name = arg.text.match(/^[A-Za-z_][A-Za-z0-9_]*/);
			if (name) names.push(name[0]);
		}
	}
	return names;
}

/**
 * Walks one `run` block for aws CLI invocations and checks every one against {@link R2_WRITERS}.
 * Returns `{ reasons, pointers }`: the violations, and the pointer keys the block writes.
 *
 * The walk is stateful: `for file in <artifact dir>/*` binds `file`, and exactly
 * `name=$(basename "$file")` then binds `name`; any other assignment to either name unbinds it,
 * and a destination ending in `${name}` is only allowed while `name` is bound.
 */
export function r2StepReasons(jobId, run, { last = false, artifactDirectories = [] } = {}) {
	const writer = R2_WRITERS[jobId];
	const reasons = [];
	const pointers = [];
	const bound = { file: false, name: false };
	// Where every value the step assigns provably lands, for the local destination of a download
	// (review round 8, finding 2).
	const values = new Map();
	const spell = (command, index) => command.words.slice(index).map((word) => word.text).join(" ");
	const inspect = (command, context) => {
		for (const substitution of command.substitutions) {
			for (const inner of shellCommands(substitution)) inspect(inner, "inside a command substitution: ");
		}
		const assigned = assignedNames(command);
		for (const variable of assigned) {
			if (writer && R2_PROTECTED_VARIABLES.test(variable)) {
				reasons.push(`${context}reassigns ${variable}, which every R2 destination is built from: ${spell(command, 0)}`);
			}
		}
		// `do`, `then`, `else` and `{` may precede the statement on the same line.
		let first = 0;
		while (first < command.words.length && /^(do|then|else|\{)$/.test(command.words[first].text)) first += 1;
		const statement = command.words.slice(first);
		const texts = statement.map((word) => word.text);
		if (texts.length === 4 && texts[0] === "for" && texts[1] === "file" && texts[2] === "in" && !statement[3].expansion && texts[3].endsWith("/*") && isArtifactDirectory(texts[3].slice(0, -2), artifactDirectories) && !texts[3].split("/").some((segment) => segment === "." || segment === ".." || segment === "") && posix.normalize(texts[3].slice(0, -2)) === texts[3].slice(0, -2) && artifactDirectories.includes(texts[3].slice(0, -2))) {
			bound.file = true;
			bound.name = false;
		} else if (texts.length === 1 && texts[0] === 'name=$(basename "$file")') {
			bound.name = bound.file;
		} else {
			if (assigned.includes("file")) bound.file = false;
			if (assigned.includes("file") || assigned.includes("name")) bound.name = false;
		}
		// Where every value the statement assigns provably lands (review round 8, finding 2): a
		// name assigned without a value (`read x`, a bare `local x`) is unknown.
		for (const name of new Set(assigned)) {
			let value = null;
			for (const word of command.words) {
				const match = word.text.match(new RegExp(`^${name}(\\[[^\\]]*\\])?\\+?=([\\s\\S]*)$`));
				if (match && !match[1]) value = match[2];
			}
			values.set(name, value === null ? { class: "unknown", literal: null } : valueClassOf(value, values, artifactDirectories));
		}
		if (texts.length >= 4 && (texts[0] === "for" || texts[0] === "select") && texts[2] === "in" && !statement[1].expansion) {
			const items = statement.slice(3).filter((word) => !/^(do|;)$/.test(word.text));
			const classes = items.map((item) => valueClassOf(item.text, values, artifactDirectories).class);
			values.set(texts[1], { class: classes.includes("artifact") ? "artifact" : classes.every((entry) => entry === "scratch" || entry === "outside") ? (classes.includes("scratch") ? "scratch" : "outside") : "unknown", literal: null });
		}
		const index = commandIndex(command.words);
		if (index === -1) return;
		const commandWord = command.words[index];
		if (posix.basename(commandWord.text) !== "aws") return;
		const spelled = spell(command, index);
		if (!writer) {
			reasons.push(`${context}invokes the aws CLI; only ${Object.keys(R2_WRITERS).join(", ")} may talk to R2: ${spelled}`);
			return;
		}
		if (commandWord.text !== "aws" || commandWord.expansion) {
			reasons.push(`${context}invokes aws through a path or expansion: ${spelled}`);
			return;
		}
		const args = command.words.slice(index + 1);
		const [service, operation] = args;
		if (!service || !operation || service.expansion || operation.expansion) {
			reasons.push(`${context}aws must name a literal service and operation: ${spelled}`);
			return;
		}
		// Options first: every operation must go to the R2 endpoint the secret names, and nothing may
		// point the CLI at another profile, region, endpoint or trust store.
		const operationKey = service.text === "s3api" ? "s3api" : `${service.text} ${operation.text}`;
		const allowedOptions = AWS_OPTIONS[operationKey];
		const positionals = [];
		let endpoints = 0;
		for (let i = 2; i < args.length; i += 1) {
			const arg = args[i];
			if (arg.text.startsWith("-")) {
				const values = allowedOptions?.[arg.text];
				if (values === undefined || arg.expansion) {
					reasons.push(`${context}aws ${operationKey} carries an option the checker does not allow: ${arg.text} (${spelled})`);
					continue;
				}
				const value = args[i + 1];
				if (arg.text === "--endpoint-url") {
					endpoints += 1;
					if (!value || !value.expansion || !AWS_ENDPOINT_VALUE.test(value.text)) {
						reasons.push(`${context}aws --endpoint-url must be exactly "$R2_ENDPOINT_URL", the secret bound at step level, never ${value?.text ?? "nothing"} (${spelled})`);
					}
				} else if (arg.text === "--region") {
					if (!value || AWS_REGION_VALUE.test(value.text) === false) {
						reasons.push(`${context}aws --region may only be auto: ${value?.text ?? "nothing"} (${spelled})`);
					}
				}
				i += values;
				continue;
			}
			positionals.push(arg);
		}
		if (allowedOptions && endpoints !== 1) {
			reasons.push(`${context}aws must carry --endpoint-url "$R2_ENDPOINT_URL" exactly once (found ${endpoints}): ${spelled}`);
		}
		if (service.text === "s3api") {
			if (AWS_S3API_READS.test(operation.text)) {
				// get-object writes the body to a local file too: the same destination rule as a
				// download (review round 8, finding 2).
				if (operation.text === "get-object") {
					const output = positionals[0];
					if (output) {
						const landing = valueClassOf(output.text, values, artifactDirectories);
						if (landing.class === "artifact") reasons.push(`${context}aws s3api get-object downloads over a downloaded artifact (${output.text}); a download may never replace a file the job uploads as verified: ${spelled}`);
						else if (landing.class !== "scratch") reasons.push(`${context}aws s3api get-object downloads to ${output.text}, which is not a literal /tmp or $RUNNER_TEMP path or a variable this step bound to one: ${spelled}`);
					}
				}
				return;
			}
			reasons.push(`${context}aws s3api ${operation.text} writes outside the 'aws s3 cp' allowlist: ${spelled}`);
			return;
		}
		if (service.text !== "s3") {
			reasons.push(`${context}aws ${service.text} is not an R2 object operation: ${spelled}`);
			return;
		}
		if (operation.text === "ls") return;
		if (operation.text !== "cp") {
			reasons.push(`${context}aws s3 ${operation.text} is not allowed; only 'aws s3 cp' with a spelled-out destination may write: ${spelled}`);
			return;
		}
		if (positionals.length !== 2) {
			reasons.push(`${context}aws s3 cp must name exactly one source and one destination: ${spelled}`);
			return;
		}
		const [source, destination] = positionals;
		if (!destination.text.startsWith("s3://")) {
			if (!source.text.startsWith("s3://")) reasons.push(`${context}aws s3 cp copies between local paths: ${spelled}`);
			// The local destination of a download may never replace a verified artifact: it must be
			// a literal /tmp path, under $RUNNER_TEMP, or a variable this step bound to one - never
			// inside a downloaded artifact directory, and never through a `..` segment (review round
			// 8, finding 2).
			const landing = valueClassOf(destination.text, values, artifactDirectories);
			if (landing.class === "artifact") reasons.push(`${context}aws s3 cp downloads over a downloaded artifact (${destination.text}); a download may never replace a file the job uploads as verified: ${spelled}`);
			else if (landing.class !== "scratch") reasons.push(`${context}aws s3 cp downloads to ${destination.text}, which is not a literal /tmp or $RUNNER_TEMP path or a variable this step bound to one: ${spelled}`);
			return;
		}
		// The source must be a downloaded artifact, spelled plainly: `artifacts/../x`, `./artifacts/x`,
		// `/artifacts/x` and `~/artifacts/x` are not (review round 5, finding 3).
		const sourceIsLoopFile = source.text === "$file" || source.text === "${file}";
		const sourceIsArtifact = !source.expansion && isArtifactPath(source.text, artifactDirectories);
		if (!(sourceIsLoopFile ? bound.file : sourceIsArtifact)) {
			reasons.push(`${context}aws s3 cp uploads something other than a downloaded artifact: ${source.text} (${spelled})`);
		}
		const bucketMatch = destination.text.match(/^s3:\/\/\$\{R2_BUCKET\}\/(.*)$/);
		if (!bucketMatch) {
			reasons.push(`${context}aws s3 cp destination must be spelled s3://\${R2_BUCKET}/<key>: ${destination.text}`);
			return;
		}
		const key = bucketMatch[1];
		if (writer.prefix) {
			const prefix = `releases/v\${${writer.prefix}}/`;
			if (key.startsWith(prefix)) {
				const object = key.slice(prefix.length);
				if (LITERAL_OBJECT_NAME.test(object)) return;
				if (object === "${name}") {
					if (bound.name) return;
					reasons.push(`${context}aws s3 cp destination uses \${name} where it is not the basename of the 'for file in artifacts/*' loop variable: ${destination.text}`);
					return;
				}
				reasons.push(`${context}aws s3 cp object name must be a literal or \${name}, never another expansion: ${destination.text}`);
				return;
			}
		}
		if (writer.pointers.includes(key)) {
			pointers.push(key);
			if (!last) reasons.push(`${context}must advance the channel pointers in its last step; '${key}' is written earlier (${spelled})`);
			return;
		}
		if (PRODUCTION_POINTERS.includes(key)) {
			if (jobId === "publish-beta-r2") reasons.push(`${context}the beta channel must never write a production pointer (${spelled})`);
			else reasons.push(`${context}only '${POINTER_JOB}' may write a production pointer; '${jobId}' does (${spelled})`);
			return;
		}
		reasons.push(`${context}aws s3 cp destination is outside the allowlist for '${jobId}' (${writer.prefix ? `releases/v\${${writer.prefix}}/<literal|\${name}>` : "no prefix"}${writer.pointers.length ? `, last step: ${writer.pointers.join(", ")}` : ""}): ${destination.text}`);
	};
	for (const command of shellCommands(run)) inspect(command, "");
	return { reasons, pointers };
}

/**
 * Returns the reasons a step misreads `aws s3api head-object`. A failed head-object is NOT proof
 * that the key is absent - a revoked token (403), a wrong endpoint or a network error fail too -
 * so the only shape allowed is the guard in {@link HEAD_OBJECT_GUARD}:
 *
 *   head_status=0
 *   aws s3api head-object ... >/tmp/head.json 2>/tmp/head.err || head_status=$?
 *   if [ "$head_status" -eq 0 ]; then          # exists
 *   elif [ "$head_status" -eq 254 ] && grep -qE '^An error occurred \((404|...)\) ...' /tmp/head.err; then   # absent
 *   else ... exit 1 ... fi                      # anything else: stop
 *
 * head-object may never be an `if`/`!`/`while` condition, its stderr must be kept in the error
 * file (not discarded or merged into stdout), `head_status` may not be assigned anywhere else,
 * and the step must run under `set -euo pipefail`.
 */
export function headObjectGuardReasons(run) {
	const reasons = [];
	const commands = [...shellCommands(run)].filter((command) => !command.casePattern && !command.heredoc);
	const spell = (command) => (command ? command.words.map((word) => word.text).join(" ") : "");
	const guard = HEAD_OBJECT_GUARD;
	// The guard lines as the parser reads them: `if [ ... ]` / `then`, and `elif [ ... ]` / `grep ...` / `then`.
	const existsSequence = splitWords(guard.exists).commands.map(spell);
	const absentSequence = splitWords(guard.absent).commands.map(spell);
	const matches = (start, sequence) => sequence.every((expected, offset) => spell(commands[start + offset]) === expected);
	let count = 0;
	commands.forEach((command, position) => {
		const index = commandIndex(command.words);
		if (index === -1) return;
		const texts = command.words.slice(index).map((word) => word.text);
		if (!(texts[0] === "aws" && texts[1] === "s3api" && texts[2] === "head-object")) return;
		count += 1;
		const spelled = texts.join(" ");
		if (command.words.slice(0, index).some((word) => /^(if|!|while|until|elif)$/.test(word.text)) || command.piped) {
			reasons.push(`uses aws s3api head-object as a condition, so a 403 or a network error would count as "absent": ${spelled}`);
		}
		const stderr = command.redirections.filter((entry) => /^2>/.test(entry.operator) || entry.operator.startsWith("&>"));
		if (stderr.length !== 1 || stderr[0].operator !== "2>" || stderr[0].text !== guard.errorFile) {
			reasons.push(`must keep the stderr of aws s3api head-object in ${guard.errorFile} so an explicit 404 can be told from any other error: ${spelled}`);
		}
		if (spell(commands[position - 1]) !== guard.reset) {
			reasons.push(`must reset '${guard.reset}' immediately before aws s3api head-object: ${spelled}`);
		}
		if (spell(commands[position + 1]) !== guard.capture) {
			reasons.push(`must capture the exit status with '|| ${guard.capture}' immediately after aws s3api head-object: ${spelled}`);
		}
		// The guard is a structure attached to THIS call, read from the parsed commands: the `if` must
		// follow the capture, its one `elif` must be the exact 404 test, and its `else` must end in
		// `exit 1`. Nothing elsewhere in the step - an unrelated `if false` block, a second `else` -
		// can stand in for a branch (review round 7, finding 5).
		if (!matches(position + 2, existsSequence)) {
			reasons.push(`must test the head-object status with exactly '${guard.exists}' immediately after capturing it (found '${spell(commands[position + 2])}'): ${spelled}`);
			return;
		}
		let depth = 0;
		let absentSeen = false;
		let elseSeen = false;
		let closed = false;
		const elseBody = [];
		for (let cursor = position + 2 + existsSequence.length; cursor < commands.length; cursor += 1) {
			const first = commands[cursor].words[0]?.text ?? "";
			if (depth === 0) {
				if (first === "elif") {
					if (!absentSeen && !elseSeen && matches(cursor, absentSequence)) {
						absentSeen = true;
						cursor += absentSequence.length - 1;
						continue;
					}
					if (!absentSeen) reasons.push(`must accept only an explicit 404 as "absent", spelled exactly: ${guard.absent} (found '${spell(commands[cursor])}')`);
					else reasons.push(`must not add another branch to the head-object guard: ${spell(commands[cursor])}`);
					return;
				}
				if (first === "else") {
					if (elseSeen) {
						reasons.push(`must not add another branch to the head-object guard: ${spell(commands[cursor])}`);
						return;
					}
					elseSeen = true;
					continue;
				}
				if (first === "fi") {
					closed = true;
					break;
				}
			}
			if (/^(if|for|while|until|case)$/.test(first)) depth += 1;
			else if (/^(fi|done|esac)$/.test(first) && depth > 0) depth -= 1;
			else if (elseSeen && depth === 0 && !/^(then|do|\{|\})$/.test(first)) elseBody.push(commands[cursor]);
		}
		if (!closed) reasons.push(`must close the head-object guard with 'fi': ${spelled}`);
		if (!absentSeen) reasons.push(`must accept only an explicit 404 as "absent", spelled exactly: ${guard.absent} (found no such branch for ${spelled})`);
		const exits = elseBody.length > 0 && spell(elseBody[elseBody.length - 1]) === "exit 1";
		const leaves = elseBody.some((command) => {
			const at = commandIndex(command.words);
			return at !== -1 && /^(continue|break|return)$/.test(command.words[at].text);
		});
		if (!elseSeen || !exits || leaves) reasons.push("must end the head-object guard with an 'else' branch that exits 1 for every other error");
	});
	if (count === 0) return reasons;
	if (spell(commands[0]) !== "set -euo pipefail") reasons.push("must start with 'set -euo pipefail' when it calls aws s3api head-object");
	for (const command of commands) {
		const spelled = spell(command);
		if (assignedNames(command).includes("head_status") && spelled !== guard.reset && spelled !== guard.capture) {
			reasons.push(`assigns head_status outside the head-object guard: ${spelled}`);
		}
	}
	return reasons;
}

/** True when an expression references any secret other than exactly `secrets.GITHUB_TOKEN`. */
export function referencesSecret(text) {
	return /\bsecrets\b/.test(String(text).replace(/\bsecrets\.GITHUB_TOKEN\b/g, ""));
}

/** Every `${{ ... }}` expression and `if:` condition in a job, wherever it appears (env, with, run, if). */
function expressionsOf(job) {
	const expressions = [];
	for (const match of JSON.stringify(job).matchAll(/\$\{\{([\s\S]*?)\}\}/g)) expressions.push(match[1]);
	for (const condition of [job.if, ...(job.steps ?? []).map((step) => step.if)]) {
		if (condition !== undefined) expressions.push(String(condition));
	}
	return expressions;
}

/**
 * The `permissions:` of a job as `[scope, level]` pairs. The scalar forms are expanded rather than
 * iterated as characters: `write-all` is every scope at write, `read-all` every scope at read.
 */
export function permissionEntries(permissions) {
	if (permissions === undefined || permissions === null) return [];
	if (typeof permissions === "string") {
		if (permissions === "write-all") return [["*", "write"]];
		if (permissions === "read-all") return [["*", "read"]];
		return [["*", permissions]];
	}
	if (typeof permissions !== "object") return [["*", String(permissions)]];
	return Object.entries(permissions).map(([scope, level]) => [scope, String(level)]);
}

/** True when a job holds something an attacker could exfiltrate or misuse. */
export function isCredentialBearing(job) {
	if (job.environment) return true;
	for (const [, level] of permissionEntries(job.permissions)) {
		if (level !== "read" && level !== "none") return true; // write, write-all, or anything the checker does not recognise
	}
	return expressionsOf(job).some(referencesSecret);
}

function needsOf(job) {
	if (!job?.needs) return [];
	return Array.isArray(job.needs) ? job.needs : [job.needs];
}

/** True when the job's permissions grant `scope` (or every scope) something other than read/none. */
function holdsWrite(job, scope) {
	return permissionEntries(job.permissions).some(([entry, level]) => (entry === scope || entry === "*") && level !== "read" && level !== "none");
}

/** What makes a job credential-bearing, for the error message. */
function credentialsOf(job) {
	const held = [];
	if (job.environment) held.push("an environment");
	for (const [scope, level] of permissionEntries(job.permissions)) {
		if (level !== "read" && level !== "none") held.push(`${scope}:${level}`);
	}
	if (expressionsOf(job).some(referencesSecret)) held.push("a secret other than GITHUB_TOKEN");
	return held.join(", ");
}

/**
 * Returns the reasons a job holds a credential outside the environment and ordering invariants
 * (review round 6, finding 1). Every credential-bearing job must declare `environment:`; the
 * exemptions in {@link ENVIRONMENT_EXEMPT_JOBS} must hold exactly the permissions listed there, no
 * secret, and the property named: sign mints OIDC only; github-release only drafts (every
 * `gh release create|edit` carries `--draft`, none carries `--draft=false` or `--latest`, `gh api`
 * never writes, git never runs); github-release-beta needs the environment-gated beta publish job.
 * Every job that holds contents:write must be one of {@link CONTENTS_WRITE_JOBS} or need verify.
 */
export function credentialJobReasons(jobId, job, jobs = {}) {
	const reasons = [];
	if (job.uses !== undefined) {
		// A reusable-workflow call is a job like any other: its permissions and secrets are checked
		// below, and the only workflow it may call is the standalone build, from the job named for
		// it - whose caller contract (exactly contents:read + id-token:write, no secrets, no
		// environment) is proved in checkWorkflows (review round 7b, finding C).
		if (jobId !== STANDALONE_CALLER_JOB || job.uses !== `./${STANDALONE_WORKFLOW}`) {
			reasons.push(`job '${jobId}' calls a reusable workflow (${job.uses}); only '${STANDALONE_CALLER_JOB}' may, and only ./${STANDALONE_WORKFLOW}: a called workflow runs code the checker does not see.`);
		} else if (JSON.stringify(permissionEntries(job.permissions).sort()) === JSON.stringify(Object.entries(STANDALONE_CALLER_PERMISSIONS).sort()) && !("secrets" in job) && job.environment === undefined && !expressionsOf(job).some(referencesSecret)) {
			return reasons; // the proven standalone caller
		}
	}
	if (holdsWrite(job, "contents") && !CONTENTS_WRITE_JOBS.includes(jobId) && !needsOf(job).includes(VERIFY_JOB)) {
		reasons.push(`job '${jobId}' holds contents:write - it could publish a release or push a tag - without being one of ${CONTENTS_WRITE_JOBS.join(", ")} or needing '${VERIFY_JOB}'.`);
	}
	if (!isCredentialBearing(job) || job.environment) return reasons;
	const exemption = ENVIRONMENT_EXEMPT_JOBS[jobId];
	if (!exemption) {
		reasons.push(`credential-bearing job '${jobId}' (holds ${credentialsOf(job)}) must run in a protected environment; only ${Object.keys(ENVIRONMENT_EXEMPT_JOBS).join(", ")} may hold a credential without one.`);
		return reasons;
	}
	const expected = JSON.stringify(Object.entries(exemption.permissions).sort());
	const actual = JSON.stringify(permissionEntries(job.permissions).sort());
	if (actual !== expected) {
		reasons.push(`job '${jobId}' may run without an environment only with exactly ${Object.entries(exemption.permissions).map(([scope, level]) => `${scope}: ${level}`).join(", ")}; it declares ${JSON.stringify(job.permissions)}.`);
	}
	if (expressionsOf(job).some(referencesSecret)) {
		reasons.push(`job '${jobId}' may run without an environment only while it references no secret other than GITHUB_TOKEN.`);
	}
	if (exemption.proof === "gated-by") {
		const gate = jobs[exemption.gate];
		if (!needsOf(job).includes(exemption.gate) || !gate?.environment) {
			reasons.push(`job '${jobId}' may run without an environment only because it needs '${exemption.gate}', which must run in one.`);
		}
	}
	if (exemption.proof === "draft-only") {
		for (const step of job.steps ?? []) {
			const label = step.name ?? step.uses ?? "(unnamed step)";
			for (const command of shellCommands(String(step.run ?? ""))) {
				if (command.casePattern || command.heredoc) continue;
				const index = commandIndex(command.words);
				if (index === -1) continue;
				const texts = command.words.slice(index).map((word) => word.text);
				const spelled = texts.join(" ");
				if (texts[0] === "git") reasons.push(`job '${jobId}' may run without an environment only while it never runs git: ${spelled} (${label}).`);
				if (texts[0] !== "gh") continue;
				const args = command.words.slice(index + 1);
				// `-XPOST`, `--method=POST`, `-f k=v`, `--input=f`: every spelling is read through the option table (review round 7b, finding B).
				if (texts[1] === "api" && ghApiWrites(args)) {
					reasons.push(`job '${jobId}' may run without an environment only while gh api never writes: ${spelled} (${label}).`);
				}
				if (texts[1] === "release" && /^(create|edit)$/.test(texts[2] ?? "")) {
					const flags = ghReleaseDraftFlags(args);
					if (flags.unknown) {
						reasons.push(`job '${jobId}' may run without an environment only while every gh release option is one the checker knows, so it can tell a --draft flag from a value: ${spelled} (${label}).`);
					}
					if (!flags.draft) {
						reasons.push(`job '${jobId}' may run without an environment only while every release it creates or edits stays a draft: ${spelled} (${label}).`);
					}
					if (flags.publishes) {
						reasons.push(`job '${jobId}' may run without an environment only while it never publishes a release: ${spelled} (${label}).`);
					}
				}
				if (texts[1] === "release" && /^(delete|delete-asset)$/.test(texts[2] ?? "")) {
					reasons.push(`job '${jobId}' may run without an environment only while it never deletes a release or asset: ${spelled} (${label}).`);
				}
			}
		}
	}
	return reasons;
}

export function checkWorkflows(read = (path) => readFileSync(path, "utf8"), list = () => readdirSync(WORKFLOW_DIRECTORY)) {
	const problems = [];
	const fail = (message) => problems.push(message);
	const release = parse(read(RELEASE_WORKFLOW));
	const triggers = release.on ?? release[true];

	if (triggers?.push?.tags) {
		fail(`${RELEASE_WORKFLOW}: a tag push must not start a release; the release job creates the tag.`);
	}
	if (JSON.stringify(release.permissions ?? null) !== "{}") {
		fail(`${RELEASE_WORKFLOW}: the workflow must declare 'permissions: {}' and let jobs opt in.`);
	}
	// A workflow-level env or default reaches every job, including the ones that run repository code.
	// The standalone workflow is scanned the same way (review round 6, finding 5): its jobs compile
	// the release binaries and hold id-token:write, so a secret or a preload variable at its top
	// level would reach repository code just as surely.
	const standalone = parse(read(STANDALONE_WORKFLOW));
	for (const [path, workflow] of [[RELEASE_WORKFLOW, release], [STANDALONE_WORKFLOW, standalone]]) {
		for (const [name, value] of Object.entries(workflow.env ?? {})) {
			if (referencesSecret(value)) fail(`${path}: the workflow-level env ${name} references a secret, which every job would receive; move it to the step that uses it.`);
			if (STARTUP_ENV.test(name)) fail(`${path}: the workflow-level env sets ${name}, which loads code before any command runs.`);
			if (CREDENTIAL_ENV.test(name)) fail(`${path}: the workflow-level env sets ${name}, which redirects where a credential is sent or which configuration a tool loads.`);
		}
		if (workflow.defaults !== undefined && referencesSecret(JSON.stringify(workflow.defaults))) {
			fail(`${path}: the workflow-level defaults reference a secret.`);
		}
		const shell = workflow.defaults?.run?.shell;
		if (shell !== undefined && !PLAIN_SHELL.test(String(shell))) {
			fail(`${path}: the workflow-level defaults set shell '${shell}', which the checker cannot read.`);
		}
	}

	for (const [jobId, job] of Object.entries(release.jobs)) {
		if (job.permissions === undefined) {
			fail(`${RELEASE_WORKFLOW}: job '${jobId}' does not declare its own permissions.`);
		} else if (typeof job.permissions !== "object" || job.permissions === null) {
			fail(`${RELEASE_WORKFLOW}: job '${jobId}' declares 'permissions: ${job.permissions}'; spell out each scope instead of a blanket grant.`);
		}
		// Every job in the release is implicitly gated on its needs succeeding. A status function in
		// `if:` replaces that gate, so a job could run after verify failed or the run was cancelled.
		if (job.if !== undefined && STATUS_FUNCTIONS.test(String(job.if))) {
			fail(`${RELEASE_WORKFLOW}: job '${jobId}' uses a status-check function in its 'if:', which would let it run after an upstream job failed or was cancelled: ${String(job.if).trim()}`);
		}
		if (job["continue-on-error"] !== undefined) {
			fail(`${RELEASE_WORKFLOW}: job '${jobId}' sets continue-on-error, which lets a failed job count as success.`);
		}
		for (const step of job.steps ?? []) {
			const label = step.name ?? step.uses ?? "(unnamed step)";
			if (step.if !== undefined && STATUS_FUNCTIONS.test(String(step.if))) {
				fail(`${RELEASE_WORKFLOW}: job '${jobId}' step '${label}' uses a status-check function in its 'if:', which would let it run after an earlier step failed: ${String(step.if).trim()}`);
			}
			if (step["continue-on-error"] !== undefined) {
				fail(`${RELEASE_WORKFLOW}: job '${jobId}' step '${label}' sets continue-on-error, which lets a failed step count as success.`);
			}
		}
		for (const [name, value] of Object.entries(job.env ?? {})) {
			if (referencesSecret(value)) {
				fail(`${RELEASE_WORKFLOW}: job '${jobId}' exposes ${name} to every step; move it to the step that uses it.`);
			}
		}
		if (!isCredentialBearing(job)) continue;
		const allowedActions = [...ALLOWED_ACTIONS["*"], ...(ALLOWED_ACTIONS[jobId] ?? [])];
		const artifactDirectories = artifactDirectoriesOf(job);
		// A default working directory or shell would change what every `run` line means.
		for (const [scope, defaults] of [["the workflow", release.defaults], [`job '${jobId}'`, job.defaults]]) {
			const directory = defaults?.run?.["working-directory"];
			if (directory !== undefined && !isArtifactDirectory(String(directory), artifactDirectories)) {
				fail(`${RELEASE_WORKFLOW}: credential-bearing job '${jobId}' must not run in a working directory other than a downloaded artifact directory (${scope} defaults to ${directory}).`);
			}
			const shell = defaults?.run?.shell;
			if (shell !== undefined && !PLAIN_SHELL.test(String(shell))) {
				fail(`${RELEASE_WORKFLOW}: credential-bearing job '${jobId}' must run bash; ${scope} defaults to shell '${shell}', which the checker cannot read.`);
			}
		}
		for (const name of Object.keys(job.env ?? {})) {
			if (STARTUP_ENV.test(name)) fail(`${RELEASE_WORKFLOW}: credential-bearing job '${jobId}' sets ${name}, which loads code before any command runs.`);
			if (CREDENTIAL_ENV.test(name)) fail(`${RELEASE_WORKFLOW}: credential-bearing job '${jobId}' sets ${name}, which redirects where a credential is sent or which configuration a tool loads.`);
		}
		for (const step of job.steps ?? []) {
			const label = step.name ?? step.uses ?? "(unnamed step)";
			for (const name of Object.keys(step.env ?? {})) {
				if (STARTUP_ENV.test(name)) fail(`${RELEASE_WORKFLOW}: credential-bearing job '${jobId}' sets ${name}, which loads code before any command runs (${label}).`);
				if (CREDENTIAL_ENV.test(name)) fail(`${RELEASE_WORKFLOW}: credential-bearing job '${jobId}' sets ${name}, which redirects where a credential is sent or which configuration a tool loads (${label}).`);
			}
			const workingDirectory = step["working-directory"] ?? job.defaults?.run?.["working-directory"] ?? release.defaults?.run?.["working-directory"];
			if (step["working-directory"] !== undefined && !isArtifactDirectory(String(step["working-directory"]), artifactDirectories)) {
				fail(`${RELEASE_WORKFLOW}: credential-bearing job '${jobId}' must not run in a working directory other than a downloaded artifact directory (${artifactDirectories.join(", ") || "none"}): working-directory: ${step["working-directory"]} (${label}).`);
			}
			if (step.shell !== undefined && !PLAIN_SHELL.test(String(step.shell))) {
				fail(`${RELEASE_WORKFLOW}: credential-bearing job '${jobId}' must run bash; shell '${step.shell}' is code the checker cannot read (${label}).`);
			}
			if (step.uses !== undefined) {
				// An allowlist: any action not named for this job - pinned or not, first- or third-party,
				// local or remote - is code running next to the credential.
				const uses = String(step.uses);
				if (uses.startsWith("./")) {
					fail(`${RELEASE_WORKFLOW}: credential-bearing job '${jobId}' must not run a local action (${uses}).`);
				} else if (!allowedActions.some((pattern) => pattern.test(uses))) {
					fail(`${RELEASE_WORKFLOW}: credential-bearing job '${jobId}' must not use ${uses}; only ${allowedActions.map((pattern) => pattern.source.replace(/^\^|@$/g, "").replaceAll("\\/", "/")).join(", ")} may run next to its credential (${label}).`);
				}
			}
			const run = String(step.run ?? "");
			// The variables the step starts with: the workflow's, the job's and the step's `env:`, and
			// nothing else - `with:` and `inputs:` reach a run block only as expression values inside
			// `env:`, never as shell names. Threading it holds the real workflow to the binding rule
			// of review round 7, finding 3, which until now only the unit tests enforced (review
			// round 8, finding 1).
			const env = { ...(release.env ?? {}), ...(job.env ?? {}), ...(step.env ?? {}) };
			const options = { artifactDirectories, workingDirectory: workingDirectory === undefined ? "" : String(workingDirectory), jobId, env };
			for (const reason of credentialStepReasons(run, options)) {
				fail(`${RELEASE_WORKFLOW}: credential-bearing job '${jobId}' ${reason} (${label}).`);
			}
		}
	}

	for (const jobId of CREDENTIAL_JOBS) {
		const job = release.jobs[jobId];
		if (!job) {
			fail(`${RELEASE_WORKFLOW}: expected a credential-bearing job named '${jobId}'.`);
			continue;
		}
		if (!job.environment) {
			fail(`${RELEASE_WORKFLOW}: job '${jobId}' must run in a protected environment.`);
		}
	}
	// Review round 6, finding 1: the environment requirement is derived, not listed. Every job the
	// checker classifies as credential-bearing must declare `environment:` unless it is one of the
	// three exemptions, and the property that justifies each exemption is proved here.
	for (const [jobId, job] of Object.entries(release.jobs)) {
		for (const reason of credentialJobReasons(jobId, job, release.jobs)) fail(`${RELEASE_WORKFLOW}: ${reason}`);
	}

	for (const jobId of ORDERED_JOBS) {
		if (!release.jobs[jobId]) fail(`${RELEASE_WORKFLOW}: expected a job named '${jobId}'.`);
	}
	const orderedPairs = [
		["publish-r2", "github-release"],
		["verify", "publish-r2"],
		["finalize-release", "verify"],
		["publish-npm", "finalize-release"],
		["tap-bump", "finalize-release"],
	];
	for (const [later, earlier] of orderedPairs) {
		if (release.jobs[later] && !needsOf(release.jobs[later]).includes(earlier)) {
			fail(`${RELEASE_WORKFLOW}: job '${later}' must need '${earlier}'; nothing may become public before verification.`);
		}
	}
	// Every aws invocation in the workflow is checked against the R2 allowlist; the pointer keys each
	// step writes fall out of that walk and drive the ordering checks below.
	const pointerSteps = new Map();
	for (const [jobId, job] of Object.entries(release.jobs)) {
		const artifactDirectories = artifactDirectoriesOf(job);
		const steps = job.steps ?? [];
		if (R2_WRITERS[jobId]) {
			const environments = [["job", job.env ?? {}], ...steps.map((step) => [`step '${step.name ?? "(unnamed)"}'`, step.env ?? {}])];
			for (const [scope, env] of environments) {
				for (const [name, source] of Object.entries(R2_ENV_SOURCES)) {
					if (env[name] !== undefined && !source.test(String(env[name]))) {
						fail(`${RELEASE_WORKFLOW}: job '${jobId}' ${scope} sets ${name} to '${env[name]}'; ${name === "AWS_DEFAULT_REGION" ? "R2 only takes the region 'auto'" : `the R2 destinations may only be built from the ${name.endsWith("VERSION") ? "context output" : "secret"}`}.`);
					}
				}
			}
		}
		steps.forEach((step, index) => {
			const label = step.name ?? step.uses ?? "(unnamed step)";
			const run = String(step.run ?? "");
			const { reasons, pointers } = r2StepReasons(jobId, run, { last: index === steps.length - 1, artifactDirectories });
			for (const reason of reasons) fail(`${RELEASE_WORKFLOW}: job '${jobId}' ${reason} (${label}).`);
			for (const reason of headObjectGuardReasons(run)) fail(`${RELEASE_WORKFLOW}: job '${jobId}' ${reason} (${label}).`);
			if (pointers.length > 0) pointerSteps.set(`${jobId}\u0000${index}`, pointers);
		});
	}
	if (release.jobs[POINTER_JOB]) {
		const steps = release.jobs[POINTER_JOB].steps ?? [];
		const pointerIndex = steps.findIndex((_, index) => pointerSteps.has(`${POINTER_JOB}\u0000${index}`));
		const written = pointerSteps.get(`${POINTER_JOB}\u0000${steps.length - 1}`) ?? [];
		const missing = PRODUCTION_POINTERS.filter((pointer) => !written.includes(pointer));
		if (missing.length > 0) {
			fail(`${RELEASE_WORKFLOW}: job '${POINTER_JOB}' must advance the production channel pointers in its last step (missing: ${missing.join(", ")}).`);
		}
		const publishIndex = steps.findIndex((step) => /gh release edit .*--draft=false/.test(String(step.run ?? "")));
		if (publishIndex === -1 || (pointerIndex !== -1 && publishIndex > pointerIndex)) {
			fail(`${RELEASE_WORKFLOW}: job '${POINTER_JOB}' must publish the GitHub release before it moves the channel pointers.`);
		}
	}

	// Review round 5, finding 4: the beta SHA256SUMS is signed and the bundle is published next to it,
	// or every compiled beta install's `prime-agent update` fails closed.
	{
		const contract = BETA_SIGNATURES;
		const sign = release.jobs[contract.signJob];
		const publish = release.jobs[contract.publishJob];
		const downloads = (job, name) => (job?.steps ?? []).filter((step) => step.uses?.startsWith("actions/download-artifact@") && step.with?.name === name);
		if (!sign) fail(`${RELEASE_WORKFLOW}: expected a job named '${contract.signJob}' to sign the beta SHA256SUMS.`);
		else {
			const condition = String(sign.if ?? "");
			if (!/needs\.context\.outputs\.publish_beta\s*==\s*'true'/.test(condition)) {
				fail(`${RELEASE_WORKFLOW}: job '${contract.signJob}' must also run when needs.context.outputs.publish_beta == 'true'; an unsigned beta makes every compiled beta install's updater fail closed (if: ${condition.trim()}).`);
			}
			if (downloads(sign, contract.artifactsArtifact).length === 0) {
				fail(`${RELEASE_WORKFLOW}: job '${contract.signJob}' must download '${contract.artifactsArtifact}' to sign the beta SHA256SUMS.`);
			}
			const upload = (sign.steps ?? []).find((step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === contract.artifact);
			if (!upload) fail(`${RELEASE_WORKFLOW}: job '${contract.signJob}' must upload an artifact named '${contract.artifact}'.`);
			else if (!String(upload.with?.path ?? "").split("\n").some((line) => line.trim().endsWith(`/${contract.bundle}`))) {
				fail(`${RELEASE_WORKFLOW}: job '${contract.signJob}' artifact '${contract.artifact}' must contain ${contract.bundle} (path: ${String(upload.with?.path ?? "").trim()}).`);
			}
			const signs = (sign.steps ?? []).some((step) => new RegExp(`cosign sign-blob[^\\n]*--bundle \\S+/${contract.bundle.replaceAll(".", "\\.")}[^\\n]*\\n?[^\\n]*beta-artifacts/SHA256SUMS`).test(joinContinuations(String(step.run ?? "")).join("\n")));
			if (!signs) fail(`${RELEASE_WORKFLOW}: job '${contract.signJob}' must run 'cosign sign-blob --yes --bundle <dir>/${contract.bundle} beta-artifacts/SHA256SUMS' for the beta.`);
		}
		if (!publish) fail(`${RELEASE_WORKFLOW}: expected a job named '${contract.publishJob}'.`);
		else {
			if (!needsOf(publish).includes(contract.signJob)) fail(`${RELEASE_WORKFLOW}: job '${contract.publishJob}' must need '${contract.signJob}' so the beta bundle exists before the beta is published.`);
			const artifacts = downloads(publish, contract.artifactsArtifact);
			const bundles = downloads(publish, contract.artifact);
			if (artifacts.length !== 1 || bundles.length !== 1) {
				fail(`${RELEASE_WORKFLOW}: job '${contract.publishJob}' must download '${contract.artifactsArtifact}' and '${contract.artifact}' exactly once each.`);
			} else if (String(artifacts[0].with?.path) !== String(bundles[0].with?.path)) {
				fail(`${RELEASE_WORKFLOW}: job '${contract.publishJob}' must download '${contract.artifact}' into the same directory as '${contract.artifactsArtifact}' (${artifacts[0].with?.path}) so the upload loop publishes ${contract.bundle} next to SHA256SUMS.`);
			}
			const directory = String(artifacts[0]?.with?.path ?? "artifacts");
			const steps = publish.steps ?? [];
			const uploadIndex = steps.findIndex((step) => step.name === contract.uploadStep);
			if (uploadIndex === -1) fail(`${RELEASE_WORKFLOW}: job '${contract.publishJob}' must keep the step '${contract.uploadStep}'.`);
			else {
				const run = String(steps[uploadIndex].run ?? "");
				if (!run.includes(`for file in ${directory}/*; do`)) fail(`${RELEASE_WORKFLOW}: job '${contract.publishJob}' step '${contract.uploadStep}' must upload every file in ${directory}/, including ${contract.bundle}.`);
				if (casePatternMatches(run, contract.bundle)) fail(`${RELEASE_WORKFLOW}: job '${contract.publishJob}' step '${contract.uploadStep}' skips ${contract.bundle}; the bundle must be published next to SHA256SUMS.`);
			}
			const verifyIndex = steps.findIndex((step) => {
				const lines = joinContinuations(String(step.run ?? ""));
				return lines.some((line) => line.includes("cosign verify-blob") && line.includes(`--bundle ${directory}/${contract.bundle}`) && line.includes(`--certificate-oidc-issuer ${contract.issuer}`) && line.includes(`--certificate-identity "${contract.identity}"`) && /\s\S*\/SHA256SUMS\s*$/.test(line) && line.includes(`${directory}/SHA256SUMS`));
			});
			if (verifyIndex === -1) {
				fail(`${RELEASE_WORKFLOW}: job '${contract.publishJob}' must run 'cosign verify-blob --bundle ${directory}/${contract.bundle} --certificate-oidc-issuer ${contract.issuer} --certificate-identity "${contract.identity}" ${directory}/SHA256SUMS' before uploading.`);
			} else if (uploadIndex !== -1 && verifyIndex > uploadIndex) {
				fail(`${RELEASE_WORKFLOW}: job '${contract.publishJob}' must verify the beta bundle before '${contract.uploadStep}'.`);
			}
			if (String(publish.env?.DEFAULT_BRANCH ?? "") !== contract.defaultBranch) {
				fail(`${RELEASE_WORKFLOW}: job '${contract.publishJob}' must set DEFAULT_BRANCH to ${contract.defaultBranch}; the beta bundle identity is pinned to refs/heads/<default branch>.`);
			}
		}
	}

	for (const path of BUILD_WORKFLOWS) {
		const workflow = parse(read(path));
		for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
			for (const step of job.steps ?? []) {
				if (step.uses && !SHA_PIN.test(step.uses) && !step.uses.startsWith("./")) {
					fail(`${path}: job '${jobId}' uses '${step.uses}' without a full commit SHA.`);
				}
				const run = String(step.run ?? "");
				// Dependency install scripts never run on a machine that produces release bytes, whatever
				// package manager or subcommand would run them.
				for (const command of shellCommands(run)) {
					for (const reason of [...lifecycleReasons(command, { workflow: path, jobId }), ...buildStepReasons(command, { workflow: path, jobId })]) {
						fail(`${path}: job '${jobId}' ${reason} (${step.name ?? step.uses ?? "(unnamed step)"}).`);
					}
				}
				// The test signer override may be compiled in exactly one place: the standalone job's
				// end-to-end updater test. Everywhere else `build-binary.mjs` runs with the production pin.
				const text = JSON.stringify(step);
				const isTestSignerStep = path === TEST_SIGNER_STEP.workflow && jobId === TEST_SIGNER_STEP.job && step.name === TEST_SIGNER_STEP.step;
				if (text.includes(TEST_SIGNER_FLAG) && !isTestSignerStep) {
					fail(`${path}: job '${jobId}' step '${step.name ?? step.uses ?? "(unnamed)"}' uses ${TEST_SIGNER_FLAG}; only '${TEST_SIGNER_STEP.step}' in ${TEST_SIGNER_STEP.workflow} may compile a test-signer binary.`);
				}
				if (/__PRIME_AGENT_RELEASE_SIGNER_OVERRIDE__/.test(text)) {
					fail(`${path}: job '${jobId}' step '${step.name ?? "(unnamed)"}' sets __PRIME_AGENT_RELEASE_SIGNER_OVERRIDE__ directly; only build-binary.mjs may define it.`);
				}
				// The uploaded standalone artifact is what the release consumes; the test-signer build must never be in it.
				if (step.uses?.startsWith("actions/upload-artifact@")) {
					const uploadPath = String(step.with?.path ?? "");
					for (const directory of TEST_SIGNER_DIRECTORIES) {
						if (uploadPath.includes(directory)) {
							fail(`${path}: job '${jobId}' uploads '${directory}', which holds test-signer builds; the release must never consume them.`);
						}
					}
					if (/\*\*|\$\{\{\s*runner\.temp\s*\}\}\/?\s*$/m.test(uploadPath)) {
						fail(`${path}: job '${jobId}' uploads a directory tree (${uploadPath.trim().split("\n").join(" ")}); list the release files explicitly so a test-signer build cannot ride along.`);
					}
				}
			}
		}
	}
	// The standalone job compiles and tests repository code AND holds id-token:write. That is only
	// safe because the identity it can mint - the called workflow path, standalone-binaries.yml -
	// is not the one the updater pins. Nothing else may be granted to it, here or by any caller.
	const trust = read(RELEASE_TRUST_SOURCE);
	const pinnedPath = trust.match(/RELEASE_SIGNER_WORKFLOW_PATH\s*=\s*"([^"]+)"/)?.[1];
	if (pinnedPath !== RELEASE_WORKFLOW) {
		fail(`${RELEASE_TRUST_SOURCE}: RELEASE_SIGNER_WORKFLOW_PATH must pin ${RELEASE_WORKFLOW}, found ${pinnedPath ?? "nothing"}; the standalone job can sign as any other path.`);
	}
	for (const [jobId, job] of Object.entries(standalone.jobs ?? {})) {
		if (job.environment) fail(`${STANDALONE_WORKFLOW}: job '${jobId}' must not run in an environment; it runs repository code.`);
		if (typeof job.permissions === "string") fail(`${STANDALONE_WORKFLOW}: job '${jobId}' declares 'permissions: ${job.permissions}'; spell out contents:read and id-token:write.`);
		for (const [scope, value] of permissionEntries(job.permissions)) {
			if (STANDALONE_CALLER_PERMISSIONS[scope] !== value) {
				fail(`${STANDALONE_WORKFLOW}: job '${jobId}' holds '${scope}: ${value}'; only contents:read and id-token:write are allowed next to repository code.`);
			}
		}
		if (expressionsOf(job).some(referencesSecret)) {
			fail(`${STANDALONE_WORKFLOW}: job '${jobId}' references a secret; it runs repository code.`);
		}
	}
	if (release.jobs.standalone?.uses !== `./${STANDALONE_WORKFLOW}`) {
		fail(`${RELEASE_WORKFLOW}: expected job 'standalone' to call ${STANDALONE_WORKFLOW}.`);
	}
	// Every caller of the standalone workflow, in every workflow file (ci.yml calls it too), passes
	// exactly contents:read + id-token:write, no secrets, no environment, and only the declared input.
	for (const file of list()) {
		if (!/\.ya?ml$/.test(file)) continue;
		const path = `${WORKFLOW_DIRECTORY}/${file}`;
		const workflow = parse(read(path));
		for (const [jobId, caller] of Object.entries(workflow?.jobs ?? {})) {
			if (caller?.uses !== `./${STANDALONE_WORKFLOW}`) continue;
			const expected = JSON.stringify(Object.entries(STANDALONE_CALLER_PERMISSIONS).sort());
			const actual = typeof caller.permissions === "object" && caller.permissions !== null ? JSON.stringify(Object.entries(caller.permissions).map(([scope, level]) => [scope, String(level)]).sort()) : null;
			if (actual !== expected) {
				fail(`${path}: job '${jobId}' calls ${STANDALONE_WORKFLOW} with permissions '${caller.permissions === undefined ? "(none declared)" : JSON.stringify(caller.permissions)}'; it must pass exactly contents: read and id-token: write, and nothing else, to a workflow that runs repository code.`);
			}
			if ("secrets" in caller) {
				fail(`${path}: job '${jobId}' passes secrets (${JSON.stringify(caller.secrets)}) to ${STANDALONE_WORKFLOW}, which runs repository code; no secret may reach it.`);
			}
			if (caller.environment !== undefined) {
				fail(`${path}: job '${jobId}' runs ${STANDALONE_WORKFLOW} in an environment; the environment's secrets would reach repository code.`);
			}
			for (const input of Object.keys(caller.with ?? {})) {
				if (!STANDALONE_CALLER_INPUTS.includes(input)) fail(`${path}: job '${jobId}' passes input '${input}' to ${STANDALONE_WORKFLOW}; only ${STANDALONE_CALLER_INPUTS.join(", ")} is declared.`);
			}
			if (expressionsOf(caller).some(referencesSecret)) {
				fail(`${path}: job '${jobId}' references a secret while calling ${STANDALONE_WORKFLOW}.`);
			}
		}
	}
	const buildJob = standalone.jobs?.[TEST_SIGNER_STEP.job];
	const testSignerStep = (buildJob?.steps ?? []).find((step) => step.name === TEST_SIGNER_STEP.step);
	if (testSignerStep) {
		const run = String(testSignerStep.run ?? "");
		if (!run.includes(TEST_SIGNER_FLAG)) {
			fail(`${STANDALONE_WORKFLOW}: step '${TEST_SIGNER_STEP.step}' must compile with ${TEST_SIGNER_FLAG}.`);
		}
		// Everything the test-signer step produces lives under $RUNNER_TEMP/test-release: the signer
		// JSON it compiles against and every archive it assembles.
		for (const line of run.split("\n")) {
			if (line.includes(TEST_SIGNER_FLAG) && !new RegExp(`${TEST_SIGNER_FLAG} "\\$RUNNER_TEMP/test-release/`).test(line)) {
				fail(`${STANDALONE_WORKFLOW}: step '${TEST_SIGNER_STEP.step}' must read the signer JSON from under $RUNNER_TEMP/test-release: ${line.trim()}`);
			}
			if (line.includes("assemble-release-archives.mjs") && !/assemble-release-archives\.mjs \S+ "\$RUNNER_TEMP\/test-release\//.test(line)) {
				fail(`${STANDALONE_WORKFLOW}: step '${TEST_SIGNER_STEP.step}' must keep the test-signer build under $RUNNER_TEMP/test-release: ${line.trim()}`);
			}
		}
		const upload = (buildJob.steps ?? []).find((step) => step.uses?.startsWith("actions/upload-artifact@"));
		const assemble = (buildJob.steps ?? []).findIndex((step) => /assemble-release-archives\.mjs[^\n]*\$RUNNER_TEMP\/standalone\b/.test(String(step.run ?? "")));
		const compile = (buildJob.steps ?? []).indexOf(testSignerStep);
		if (upload && !/\$\{\{\s*runner\.temp\s*\}\}\/standalone\//.test(String(upload.with?.path ?? ""))) {
			fail(`${STANDALONE_WORKFLOW}: the standalone artifact must upload only from $RUNNER_TEMP/standalone/.`);
		}
		if (assemble !== -1 && compile < assemble) {
			fail(`${STANDALONE_WORKFLOW}: the release archive must be assembled before '${TEST_SIGNER_STEP.step}' compiles anything else.`);
		}
	}

	return problems;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	const problems = checkWorkflows();
	for (const problem of problems) console.error(`error: ${problem}`);
	if (problems.length > 0) process.exit(1);
	console.log("release workflow invariants hold");
}
