import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { loadSkillsFromDir } from "../src/core/skills.js";

const SUPERPOWERS_ROOT = join(getBundledSkillsDir(), "superpowers");
const SUPERPOWERS_VERSION = "6.2.0";
const SUPERPOWERS_COMMIT = "9ba3bcd10b9e92be0b299d8721f1393b92e911a0";
const MODIFIED_UPSTREAM_FILES = [
	"skills/brainstorming/SKILL.md",
	"skills/brainstorming/spec-document-reviewer-prompt.md",
	"skills/brainstorming/visual-companion.md",
	"skills/dispatching-parallel-agents/SKILL.md",
	"skills/executing-plans/SKILL.md",
	"skills/finishing-a-development-branch/SKILL.md",
	"skills/receiving-code-review/SKILL.md",
	"skills/requesting-code-review/SKILL.md",
	"skills/requesting-code-review/code-reviewer.md",
	"skills/subagent-driven-development/SKILL.md",
	"skills/subagent-driven-development/implementer-prompt.md",
	"skills/subagent-driven-development/re-review-prompt.md",
	"skills/subagent-driven-development/scripts/review-package",
	"skills/subagent-driven-development/task-reviewer-prompt.md",
	"skills/systematic-debugging/CREATION-LOG.md",
	"skills/systematic-debugging/condition-based-waiting-example.ts",
	"skills/systematic-debugging/condition-based-waiting.md",
	"skills/systematic-debugging/SKILL.md",
	"skills/systematic-debugging/defense-in-depth.md",
	"skills/systematic-debugging/find-polluter.sh",
	"skills/systematic-debugging/root-cause-tracing.md",
	"skills/test-driven-development/SKILL.md",
	"skills/test-driven-development/writing-good-tests.md",
	"skills/using-git-worktrees/SKILL.md",
	"skills/using-superpowers/SKILL.md",
	"skills/using-superpowers/references/antigravity-tools.md",
	"skills/using-superpowers/references/codex-tools.md",
	"skills/using-superpowers/references/gemini-tools.md",
	"skills/using-superpowers/references/pi-tools.md",
	"skills/verification-before-completion/SKILL.md",
	"skills/writing-plans/SKILL.md",
	"skills/writing-plans/plan-document-reviewer-prompt.md",
	"skills/writing-skills/SKILL.md",
	"skills/writing-skills/examples/CLAUDE_MD_TESTING.md",
	"skills/writing-skills/graphviz-conventions.dot",
	"skills/writing-skills/anthropic-best-practices.md",
	"skills/writing-skills/testing-skills-with-subagents.md",
] as const;
const EXECUTABLE_UPSTREAM_FILES = new Set([
	"skills/brainstorming/scripts/start-server.sh",
	"skills/brainstorming/scripts/stop-server.sh",
	"skills/subagent-driven-development/scripts/review-package",
	"skills/subagent-driven-development/scripts/sdd-workspace",
	"skills/subagent-driven-development/scripts/task-brief",
	"skills/systematic-debugging/find-polluter.sh",
	"skills/writing-skills/render-graphs.js",
]);
const LOCAL_PROVENANCE_FILES = new Set(["UPSTREAM.md", "PATCHES.md", "SOURCE.json", "THIRD_PARTY_NOTICE.md"]);
const REFERENCE_SYNTAX = [
	"Markdown links",
	"inline scripts/references paths",
	"sibling filenames",
	"root-escape rejection",
] as const;
const REFERENCE_LIMITS = ["External URLs, anchors", "unsupported syntax", "Bare filenames"] as const;

type ForkContract = Record<string, string>;

interface PolicyScenario {
	name: string;
	skillName: string;
	wanted: Record<string, string | boolean>;
}

const EXPECTED_UPSTREAM_SHA256: Record<string, string> = {
	"skills/brainstorming/SKILL.md": "4a54a4858b99807f3155ed1614b2f116e35ea5c1b788e793f565dd837fd3891f",
	"skills/brainstorming/scripts/frame-template.html":
		"6a8a4e58bd6a44b904e2e3c57de774481d909204597e1498de53f1b2fecc4c4e",
	"skills/brainstorming/scripts/helper.js": "43c6d69954a46ec34a2a262bcc62a9a7e83e839c739f199cb72646d397c686e3",
	"skills/brainstorming/scripts/server.cjs": "2d2961ea8d11f56c5f4c3a1a68d22709efa5d7601a2246d8c880774e7e9e8412",
	"skills/brainstorming/scripts/start-server.sh": "a4e5ae84275bcaacd2f84345afeabe59cf7b00ba080e123da7cc1fb226f12847",
	"skills/brainstorming/scripts/stop-server.sh": "0b5ccbbd57f62d3ed88993f7940b5ee0e5c0fc9b21c550c623da4f6292e47daf",
	"skills/brainstorming/spec-document-reviewer-prompt.md":
		"95a0a195de9d984be2fffa95bab16fc8c563bc296a9cfc5e9c29cb3ece0d7457",
	"skills/brainstorming/visual-companion.md": "60cbad29b9dd7eaf08da020e301c498a72230b2e13c1813fa967a135ffcc1d71",
	"skills/dispatching-parallel-agents/SKILL.md": "1968923066f3b707eb01d1992cdf4c42284c3855f70253b9cd5000ff45fca13c",
	"skills/executing-plans/SKILL.md": "c4c3d8b628c51114cd165fb8246fe02744cd8be180032328391252e653028d9b",
	"skills/finishing-a-development-branch/SKILL.md": "d0ac8360ed9d59121776ef95c84bcb38e9747de0d7ae7e227dca81e437593b9b",
	"skills/receiving-code-review/SKILL.md": "091df1629510af1b92fc4abd6f96732ebedb4cb2c0f3457e8f2740b0504a2438",
	"skills/requesting-code-review/SKILL.md": "d71cc01ba56d2325cf8af5f7c11837819b63ecd57de0bfdb812f7f3ff7751df8",
	"skills/requesting-code-review/code-reviewer.md": "b2f2ec7596925fe52dac158fdfbca19b3a7d779d619c481e6706a6c0001662d3",
	"skills/subagent-driven-development/SKILL.md": "690e8b0af93da5bf6a4d5b369ff2ac4db960b81dfc37ad481025d1b1df16a3e4",
	"skills/subagent-driven-development/implementer-prompt.md":
		"7246841ad6e6af4b1e9ddc73093cbd936d4721369e6edae676f7aab8e86eca80",
	"skills/subagent-driven-development/re-review-prompt.md":
		"62f28f8908860efae1971a68e6ad1776c766f6e1bf0dca43b679feacf98f1296",
	"skills/subagent-driven-development/scripts/review-package":
		"fac3d4bd7f94369e8037b9ead2a8a502dca6ab333902b560b9455dbb3c450ebe",
	"skills/subagent-driven-development/scripts/sdd-workspace":
		"95a09d9d3983ad1aafd093ca72b4587946dea885c6e302caa02a779a2f911c31",
	"skills/subagent-driven-development/scripts/task-brief":
		"d6954ef7841c7da3d77373e6ff5118b3f2f2e998606fd95d33e6527851bce044",
	"skills/subagent-driven-development/task-reviewer-prompt.md":
		"547567c65275956244df7b4dd22aefa1756d933b32826a76abccaeb559c3738d",
	"skills/systematic-debugging/CREATION-LOG.md": "c24733a5b1821bd6bed1fc950261f0b9f4e90097e0bbb96459d8179713730789",
	"skills/systematic-debugging/SKILL.md": "808fc5717aa88ad65efff312b11c186294d3e6ee301afb584e2f86599b137787",
	"skills/systematic-debugging/condition-based-waiting-example.ts":
		"40ae5ebe497fdf310200e43fe986552546d0a22837c0d39e855db1cfd33eb88e",
	"skills/systematic-debugging/condition-based-waiting.md":
		"e89fec8400d6cd50f43407cec9fab50976ba4d55d0ec2eb51c0bd68036b54c26",
	"skills/systematic-debugging/defense-in-depth.md":
		"1e175fb86fc357e58c6aebf5441e481e1b7868b4380c0456b63a17eefbd18ba7",
	"skills/systematic-debugging/find-polluter.sh": "dd7b8f13c4cc2a24b33ff87b18da9248f3e1c80a085c3316224f69ff0fa5c43c",
	"skills/systematic-debugging/root-cause-tracing.md":
		"6b0622269e098ca1399e123e553fd385f0b6412d88ef0e9c4f5a8ea9cf1cec7b",
	"skills/systematic-debugging/test-academic.md": "fe2ba480d78ac0d686dc025f41c2a32a43d642bf533f91b0c6053a04d35d6486",
	"skills/systematic-debugging/test-pressure-1.md": "0b6a915db0054577819834c79be9eb614e97bddba10d73768e1fbe91cfed048a",
	"skills/systematic-debugging/test-pressure-2.md": "b2030aeffba07050e8ad573ddf87486457c4a016a786bb326235bebd856f2016",
	"skills/systematic-debugging/test-pressure-3.md": "96b50a52e2c7989c9cf20fb752c47c1e9a3a70dc362f8f7989f8f5b64dac7708",
	"skills/test-driven-development/SKILL.md": "bf1b8216e523851a411e91d429a7c1c2a173e79d88957bc78e348218d50edd54",
	"skills/test-driven-development/writing-good-tests.md":
		"51471c853306ff92ca8bb41dcaea05f31c0e46b03651f8f3c99754b7172f4ae1",
	"skills/using-git-worktrees/SKILL.md": "8cfb86f121269e8f7f12361e6795c4f6738828340e28964c9229d365666c9edd",
	"skills/using-superpowers/SKILL.md": "55379fe7c1c473a02c61961c822996bff30e1320d6921d9062509bc508482c05",
	"skills/using-superpowers/references/antigravity-tools.md":
		"4880f6de3da4e32f9659ebe7a72b9e0ebfff04e028c2ed96173f86d0387a04c0",
	"skills/using-superpowers/references/codex-tools.md":
		"b9a5ee87376a5d9db10e7e234ea13243fe02af221593e68bbd8d1e55c552f321",
	"skills/using-superpowers/references/gemini-tools.md":
		"62b9157bcb0ee3c6784e3d0da0798ddfa5872f9e0c34bea48f3079dabea71965",
	"skills/using-superpowers/references/pi-tools.md":
		"703dbc83d23ecab9c6f388460c38abc482e9dee2fe6772a8c7a255152ad3a4d5",
	"skills/verification-before-completion/SKILL.md": "2befe7fc55bcadaa3d97dd9e8efeb633d2561c0ebe74c5a8b17c4d9e7e4520b3",
	"skills/writing-plans/SKILL.md": "e8107a58237dcc60b5569b61d0448fd7ba4691467b26661172c83fa73e1b9e",
	"skills/writing-plans/plan-document-reviewer-prompt.md":
		"aa728b96aad603c8be28875a4305637f6c984aa81ffcadcb13e743202fa2a0c7",
	"skills/writing-skills/SKILL.md": "d34db5c8aed6a4e0440132bd0613aace70a693ec7819d5637ad77481d8e10d1b",
	"skills/writing-skills/anthropic-best-practices.md":
		"217629b356c09c9bd11017c9788e8fc654ca1b32c92d4a51cd490e16dd65e59a",
	"skills/writing-skills/examples/CLAUDE_MD_TESTING.md":
		"0b379a3415e185d3c434b3ad283d8aa132f3022c2a4f210f168865b5986bcef0",
	"skills/writing-skills/graphviz-conventions.dot": "e2890a593c91370e384b42f2f67b1a6232c9e69dddea7891a0c1c46d7b20b694",
	"skills/writing-skills/persuasion-principles.md": "a51bc9bf75189ea73a27b3fb504a2fdfdb966fb1f7f1cdf03203230a216ccc03",
	"skills/writing-skills/render-graphs.js": "ccda971a87bb185f8febf81c56b556a20d026fa980c17b35fa3e8824fbb37852",
	"skills/writing-skills/testing-skills-with-subagents.md":
		"c711346852c911b24a84aa161e0cff06a4cd7f4e2fa9e9c0a266cead5afcbade",
	LICENSE: "a37e0e9697144819e1d965176ac4ae5bc3fa02d11e7812036bbcadf6dafe2400",
};

const EXPECTED_FORK_SHA256: Record<string, string> = {
	"skills/brainstorming/SKILL.md": "74f15ccb7f566cf6845e6cbff33a617289825fd478dda959b42e273e3baf8eef",
	"skills/brainstorming/spec-document-reviewer-prompt.md":
		"4d3e669146551263a1723e9a07a4e682f08739069f0a4039b509f41f0f7d4923",
	"skills/brainstorming/visual-companion.md": "c41ffbca297fff9ababe4293c5cf3b2334cc54c61f163ff2a6fe7a72638e320e",
	"skills/dispatching-parallel-agents/SKILL.md": "fd0a6d86df83641647cc150384d88a7255c986e7b65dc36e37ad3468a0c5fb08",
	"skills/executing-plans/SKILL.md": "dc95235696ec04a92353e3bf7bb72758c000cc547070e86abe00f868c48f8bc6",
	"skills/finishing-a-development-branch/SKILL.md": "51e8e45faa64d735339f2368b90a3fd8d483155791888e6b468a65d781fed465",
	"skills/receiving-code-review/SKILL.md": "c4c1828dc41b306dae50c6a0de382a61ddbb7e053f96da5c100d856a7e48c401",
	"skills/requesting-code-review/SKILL.md": "fe146241005f17d05728f3abd47622c7af3bd94583baf15422e237a464640de5",
	"skills/requesting-code-review/code-reviewer.md": "832abf7688e0b2445788c5e0fa44a4bb510ea6f4514196ece791d35b786331a0",
	"skills/subagent-driven-development/SKILL.md": "7c6a41e8df321d5cbcf8aa8d170894611d67811a0161fb106f99a922dee34ea7",
	"skills/subagent-driven-development/implementer-prompt.md":
		"48a6a46c40fb9c20d832353d1e1b655cc0f8e03e5815ff096c0c462e48208a7c",
	"skills/subagent-driven-development/re-review-prompt.md":
		"97e02d9e3b37947e9ee1e57635da1181cc87c59065474284666aa417bd4486ae",
	"skills/subagent-driven-development/scripts/review-package":
		"b15386c87ef3ebd94b9b5fa590272abd16eb940732cb28273efb5e44fc8b67e9",
	"skills/subagent-driven-development/task-reviewer-prompt.md":
		"0cab2e9e1efe63fea9bad425a2717332a4c49436580f4ce03af9f9fd8d2486d8",
	"skills/systematic-debugging/SKILL.md": "0aaa02532aa339dbaee12ab6e4f16b05400f2f9fd59c7d1d04ff53fb07fd5cff",
	"skills/systematic-debugging/CREATION-LOG.md": "e7278e7c738129233e70a6922c06ff3a13acede701f37589fcd4c405b092544a",
	"skills/systematic-debugging/condition-based-waiting-example.ts":
		"485a4d50d9ba48e06c3dc98f7418ea4c182b0653c69c0efd35044aea19076efc",
	"skills/systematic-debugging/condition-based-waiting.md":
		"508d523b4bba8db6639be6a38a55b23b1d6ebfdbf6c276f5d2bade7ca9518458",
	"skills/systematic-debugging/defense-in-depth.md":
		"1f77b40936c30aa8989e6db191a7ade2bbf5c18d7a1359064b3f6fc8a8afee4a",
	"skills/systematic-debugging/find-polluter.sh": "d55f1c9f5759641e4d56f04a47744ae971a9a66206c12bd18ecd98835bec9bb3",
	"skills/systematic-debugging/root-cause-tracing.md":
		"78a4ea10447f96480e57a4686dcc0f1d6b001095fd597f41fda0169cefc0027c",
	"skills/test-driven-development/SKILL.md": "8d1509519bdfdaeb824309e957039ecd71c3f0cadc4ab6dee3982b945dcdbce5",
	"skills/test-driven-development/writing-good-tests.md":
		"26ede517a143446803f3741440f5dd32e95225f9bbea2baad06bfa1b08e21bc1",
	"skills/using-git-worktrees/SKILL.md": "a15f0e8b11efecd4dda8b63a913a9e2ae02e7e970a4b8ce0a8e022b147f07beb",
	"skills/using-superpowers/SKILL.md": "57e74ad4cab995d83da99e2bf831a0f4b9443c76b37ad351035f84fe7650db1f",
	"skills/using-superpowers/references/antigravity-tools.md":
		"33fabbcd18ec25710eac14b7da8a9045eeb965542697326de2a67e79f22f6c6c",
	"skills/using-superpowers/references/codex-tools.md":
		"7954c6b647139183a3c6ccef012dd77e4f602d3548cc1ae17e48b53fff6753f5",
	"skills/using-superpowers/references/gemini-tools.md":
		"8b7ad905ef881cee15eb149faf09b5dd4ea1112fbea05ee8d53c5e7fe3431fcd",
	"skills/using-superpowers/references/pi-tools.md":
		"084465e8abc466f8ebff4a3ad6ad359e3a5dedc20b7b17caa975cbfec08441c2",
	"skills/verification-before-completion/SKILL.md": "8d7cc3798e328fe6700b6386208b5a2649258314c336233b5ce447c1a4ce04e0",
	"skills/writing-plans/SKILL.md": "b1a4367b0dc6fe7d55d4092db0f58f6f38f5b56fce550f2a160fb2424dff3059",
	"skills/writing-plans/plan-document-reviewer-prompt.md":
		"b288d40310de47f4a534493d1eb97016fc1c5a9b39dc25198615b43bf3a0b0fa",
	"skills/writing-skills/SKILL.md": "24c5a2a74e98cb353dae4079b0f09c59cf4b9b250bcffadc39061f8d7ca5d881",
	"skills/writing-skills/anthropic-best-practices.md":
		"0757487f40b7fb7d53b38d67fb824918ec3c58089b63805cedd3b95c60be3a00",
	"skills/writing-skills/examples/CLAUDE_MD_TESTING.md":
		"3631fe9522a97935aeeb234b5085257745f5c81b1b16d7948e01b00aecc64c6e",
	"skills/writing-skills/graphviz-conventions.dot": "2680fcc10841b98c739363c03dbaba4cad94cafc67993ea4c72c2a0772029fe8",
	"skills/writing-skills/testing-skills-with-subagents.md":
		"b3f4830b8ba39aa06a9bfbb5888c64c4523f14168d56c3a6c8e8fa7de8ac962b",
};

function listFiles(root: string, current: string = root): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		const fullPath = join(current, entry.name);
		if (entry.isDirectory()) {
			files.push(...listFiles(root, fullPath));
		} else {
			files.push(relative(root, fullPath).split(sep).join("/"));
		}
	}
	return files.sort();
}

function sha256(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isWithinSuperpowersRoot(filePath: string): boolean {
	const pathFromRoot = relative(SUPERPOWERS_ROOT, filePath);
	return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function loadedSkillText(name: string): string {
	const result = loadSkillsFromDir({ dir: SUPERPOWERS_ROOT, source: "builtin" });
	const skill = result.skills.find((candidate) => candidate.name === name);
	if (!skill) {
		throw new Error(`bundled skill ${name} was not discovered`);
	}
	return readFileSync(skill.filePath, "utf8");
}

function parseForkContract(name: string): ForkContract {
	const content = loadedSkillText(name);
	const contractLines = content.match(/^## Prime Agent fork contract\n\n((?:- Contract: `[^`]+`\n)+)/m)?.[1];
	if (!contractLines) {
		throw new Error(`skill ${name} has no Prime Agent fork contract`);
	}

	const contract: ForkContract = {};
	for (const line of contractLines.trim().split("\n")) {
		const values = line.match(/^- Contract: `([^`]+)`$/)?.[1];
		if (!values) {
			throw new Error(`invalid fork contract line in ${name}: ${line}`);
		}
		for (const entry of values.split(";")) {
			const [key, value] = entry.trim().split("=", 2);
			if (!key || !value) {
				throw new Error(`invalid fork contract entry in ${name}: ${entry}`);
			}
			contract[key] = value;
		}
	}
	return contract;
}

function evaluatePolicyScenario(scenario: PolicyScenario): Record<string, string | boolean> {
	const contract = parseForkContract(scenario.skillName);
	switch (scenario.skillName) {
		case "brainstorming":
			return {
				writes: contract.write !== "none",
				commits: contract.commit !== "none",
				standaloneDesign: contract["standalone-design"] !== "skip-small",
				designImplementationCode: contract["design-code"] !== "none",
			};
		case "writing-plans":
			return {
				output: contract.output,
				implementationPseudocode: contract["implementation-pseudocode"] !== "none",
				implementerOwnership: contract.implementer,
			};
		case "requesting-code-review":
			return {
				callerSuppliedImmutableShas:
					contract["sha-input"] === "caller-supplied-canonical-full-base-candidate-integration",
				movingHeadDefault: contract["moving-head-default"] !== "forbidden",
				exactShaBeforeIntegration: contract.integration === "exact-sha-review-before",
			};
		case "using-git-worktrees":
			return {
				substantialBranchSource: contract.substantial,
				smallEditOwner: contract.small,
				mergeBaseAllowed: contract["merge-base"] !== "forbidden",
				workspaceHeadCheck: contract["workspace-head"] === "exact-integration-sha",
			};
		case "subagent-driven-development":
			return {
				roleAuthority: contract["authority-model"],
				capacitySource: contract.capacity,
				capacitySelection: contract["capacity-selection"],
				hardcodedModelFamilies: contract["hardcoded-model-families"] !== "forbidden",
			};
		case "test-driven-development":
			return {
				intentAndForbiddenOutcomes: contract.intent === "required" && contract["forbidden-outcomes"] === "required",
				blackBoxAcceptance: contract.acceptance === "black-box-public-boundary",
				observedRed: contract.red === "observed-recorded-before-implementation",
				adversarialRegression: contract["adversarial-probes"] === "regression-before-fix",
				durabilityEvidence: contract.durability === "real-store-process-restart",
				adversarialChecks: contract.adversarial === "metamorphic,race,caller-mutation,locale,stale-replay",
				antiCheating: contract["anti-cheating"] === "required",
				mockOnlyInadequate: contract.mocks === "mock-only-inadequate",
				greenReview: contract.green === "independent-verification-adversarial-review",
			};
		case "executing-plans":
		case "systematic-debugging":
		case "using-superpowers":
			return {
				publicAcceptance:
					contract.acceptance === "public-intent-boundary" || contract.acceptance === "black-box-public-boundary",
				unitTestsSupplemental: contract["unit-probes"] === "temporary-debugging-only",
				mockOnlyInadequate: contract.mocks === "mock-only-inadequate",
				authority: contract.authority === "methodology-only",
			};
		case "finishing-a-development-branch":
		case "verification-before-completion":
			return {
				authority: contract.authority,
				writes: contract.write,
				approvals: contract.approval,
				merges: contract.merge,
				completion: contract.completion,
			};
		default:
			throw new Error(`no scenario interpreter for ${scenario.skillName}`);
	}
}

function addLocalReference(
	manifestPath: string,
	rawReference: string,
	references: Set<string>,
	allowBareRelative: boolean,
): void {
	let candidate = rawReference.trim().split(/\s+/)[0] ?? "";
	candidate = candidate
		.replace(/^<|>$/g, "")
		.split("#", 1)[0]
		.replace(/[),.;:!?]+$/g, "");
	if (
		candidate === "" ||
		candidate.startsWith("http://") ||
		candidate.startsWith("https://") ||
		candidate.startsWith("mailto:") ||
		candidate.startsWith("/") ||
		candidate.startsWith("#")
	) {
		return;
	}

	// These are intentionally illustrative paths in upstream guidance, not bundled resources.
	if (
		candidate.includes("<") ||
		candidate.includes(">") ||
		candidate === "./" ||
		candidate === "../some-skill" ||
		candidate.startsWith("skills/path/") ||
		candidate.startsWith("skills/testing/")
	) {
		return;
	}

	const packageRelative = candidate.startsWith("skills/");
	const hasLocalPrefix =
		candidate.startsWith("./") ||
		candidate.startsWith("../") ||
		candidate.startsWith("scripts/") ||
		candidate.startsWith("references/") ||
		packageRelative;
	if (!hasLocalPrefix && !(allowBareRelative && !candidate.includes("/"))) {
		return;
	}

	const target = packageRelative
		? resolve(SUPERPOWERS_ROOT, candidate.slice("skills/".length))
		: resolve(dirname(manifestPath), candidate);
	if (!isWithinSuperpowersRoot(target)) {
		throw new Error(`local reference escapes bundled skill root: ${candidate}`);
	}
	references.add(target);
}

function localReferencesForSkill(manifestPath: string): string[] {
	const content = readFileSync(manifestPath, "utf8");
	const references = new Set<string>();
	for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g)) {
		addLocalReference(manifestPath, match[1] ?? "", references, true);
	}
	for (const match of content.matchAll(
		/(?:^|[\s([>`])((?:\.\.?\/|scripts\/|references\/|skills\/)[^\s`"'()<>\],;:!?]+)/g,
	)) {
		addLocalReference(manifestPath, match[1] ?? "", references, false);
	}
	for (const match of content.matchAll(
		/(?:^|[\s([>`"'])([A-Za-z0-9_.-]+\.(?:md|html|js|cjs|sh|ts|dot))(?=$|[\s)\],.;:!?`"'])/g,
	)) {
		const candidate = match[1] ?? "";
		const target = resolve(dirname(manifestPath), candidate);
		if (!isWithinSuperpowersRoot(target)) {
			throw new Error(`local reference escapes bundled skill root: ${candidate}`);
		}
		const sourcePath = `skills/${relative(SUPERPOWERS_ROOT, target).split(sep).join("/")}`;
		if (Object.hasOwn(EXPECTED_UPSTREAM_SHA256, sourcePath)) {
			references.add(target);
		}
	}
	return [...references].sort();
}

const POLICY_SCENARIOS: PolicyScenario[] = [
	{
		name: "small design request is read-only and skips standalone artifacts",
		skillName: "brainstorming",
		wanted: {
			writes: false,
			commits: false,
			standaloneDesign: false,
			designImplementationCode: false,
		},
	},
	{
		name: "plan output is a concise task graph and implementer owns product/tests",
		skillName: "writing-plans",
		wanted: {
			output: "task-graph,constraints,acceptance",
			implementationPseudocode: false,
			implementerOwnership: "product-and-tests",
		},
	},
	{
		name: "review binds immutable caller SHAs before integration",
		skillName: "requesting-code-review",
		wanted: {
			callerSuppliedImmutableShas: true,
			movingHeadDefault: false,
			exactShaBeforeIntegration: true,
		},
	},
	{
		name: "worktree policy pins substantial work and keeps small edits local",
		skillName: "using-git-worktrees",
		wanted: {
			substantialBranchSource: "branch-from-integration-sha,propose-to-integration",
			smallEditOwner: "coordinator",
			mergeBaseAllowed: false,
			workspaceHeadCheck: true,
		},
	},
	{
		name: "scheduler owns role capacity without model-family policy",
		skillName: "subagent-driven-development",
		wanted: {
			roleAuthority: "role-based",
			capacitySource: "host-assigned-luna",
			capacitySelection: "host-scheduler",
			hardcodedModelFamilies: false,
		},
	},
	{
		name: "TDD requires public intent RED and adversarial evidence",
		skillName: "test-driven-development",
		wanted: {
			intentAndForbiddenOutcomes: true,
			blackBoxAcceptance: true,
			observedRed: true,
			adversarialRegression: true,
			durabilityEvidence: true,
			adversarialChecks: true,
			antiCheating: true,
			mockOnlyInadequate: true,
			greenReview: true,
		},
	},
	...(["executing-plans", "systematic-debugging", "using-superpowers"] as const).map((skillName) => ({
		name: `${skillName} routes public intent evidence without unit-only promotion`,
		skillName,
		wanted: {
			publicAcceptance: true,
			unitTestsSupplemental: true,
			mockOnlyInadequate: true,
			authority: true,
		},
	})),
	...(["finishing-a-development-branch", "verification-before-completion"] as const).map((skillName) => ({
		name: `${skillName} confers methodology only`,
		skillName,
		wanted: {
			authority: "methodology-only",
			writes: "none",
			approvals: "none",
			merges: "none",
			completion: "none",
		},
	})),
];

const ROUTED_POLICY_SKILLS = [
	"brainstorming",
	"dispatching-parallel-agents",
	"executing-plans",
	"finishing-a-development-branch",
	"receiving-code-review",
	"requesting-code-review",
	"subagent-driven-development",
	"systematic-debugging",
	"test-driven-development",
	"using-git-worktrees",
	"using-superpowers",
	"verification-before-completion",
	"writing-plans",
	"writing-skills",
] as const;

const IMPLEMENTATION_POLICY_SKILLS = [
	"dispatching-parallel-agents",
	"executing-plans",
	"subagent-driven-development",
	"systematic-debugging",
	"test-driven-development",
	"using-superpowers",
	"writing-plans",
] as const;

const REVIEW_POLICY_FILES = [
	"skills/brainstorming/spec-document-reviewer-prompt.md",
	"skills/dispatching-parallel-agents/SKILL.md",
	"skills/receiving-code-review/SKILL.md",
	"skills/writing-plans/plan-document-reviewer-prompt.md",
	"skills/requesting-code-review/SKILL.md",
	"skills/requesting-code-review/code-reviewer.md",
	"skills/subagent-driven-development/SKILL.md",
	"skills/subagent-driven-development/implementer-prompt.md",
	"skills/subagent-driven-development/re-review-prompt.md",
	"skills/subagent-driven-development/task-reviewer-prompt.md",
	"skills/subagent-driven-development/scripts/review-package",
	"skills/using-git-worktrees/SKILL.md",
	"skills/using-superpowers/references/antigravity-tools.md",
	"skills/using-superpowers/references/codex-tools.md",
	"skills/using-superpowers/references/gemini-tools.md",
	"skills/using-superpowers/references/pi-tools.md",
] as const;

const INTENT_TEST_POLICY_FILES = [
	"skills/brainstorming/SKILL.md",
	"skills/dispatching-parallel-agents/SKILL.md",
	"skills/executing-plans/SKILL.md",
	"skills/receiving-code-review/SKILL.md",
	"skills/requesting-code-review/SKILL.md",
	"skills/requesting-code-review/code-reviewer.md",
	"skills/subagent-driven-development/SKILL.md",
	"skills/subagent-driven-development/implementer-prompt.md",
	"skills/subagent-driven-development/re-review-prompt.md",
	"skills/subagent-driven-development/task-reviewer-prompt.md",
	"skills/systematic-debugging/SKILL.md",
	"skills/systematic-debugging/CREATION-LOG.md",
	"skills/systematic-debugging/defense-in-depth.md",
	"skills/systematic-debugging/root-cause-tracing.md",
	"skills/systematic-debugging/condition-based-waiting.md",
	"skills/systematic-debugging/condition-based-waiting-example.ts",
	"skills/test-driven-development/SKILL.md",
	"skills/test-driven-development/writing-good-tests.md",
	"skills/verification-before-completion/SKILL.md",
	"skills/writing-plans/SKILL.md",
	"skills/using-superpowers/SKILL.md",
	"skills/writing-skills/testing-skills-with-subagents.md",
] as const;
const UNIT_POLICY_FILES = [
	"skills/test-driven-development/SKILL.md",
	"skills/test-driven-development/writing-good-tests.md",
	"skills/systematic-debugging/SKILL.md",
	"skills/systematic-debugging/CREATION-LOG.md",
	"skills/systematic-debugging/condition-based-waiting.md",
	"skills/systematic-debugging/defense-in-depth.md",
	"skills/systematic-debugging/root-cause-tracing.md",
	"skills/writing-skills/SKILL.md",
	"skills/writing-skills/testing-skills-with-subagents.md",
] as const;
const ROUTED_PROMPT_POLICY_FILES = [
	"skills/brainstorming/spec-document-reviewer-prompt.md",
	"skills/requesting-code-review/code-reviewer.md",
	"skills/subagent-driven-development/implementer-prompt.md",
	"skills/subagent-driven-development/re-review-prompt.md",
	"skills/subagent-driven-development/task-reviewer-prompt.md",
	"skills/writing-plans/plan-document-reviewer-prompt.md",
] as const;

function bundledFile(relativePath: string): string {
	const skillRelativePath = relativePath.startsWith("skills/") ? relativePath.slice("skills/".length) : relativePath;
	return readFileSync(join(SUPERPOWERS_ROOT, ...skillRelativePath.split("/")), "utf8");
}

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function expectReviewPackageFailure(cwd: string, args: string[]): void {
	expect(() =>
		execFileSync(join(SUPERPOWERS_ROOT, "subagent-driven-development/scripts/review-package"), args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		}),
	).toThrow();
}

function worktreeGuardScript(): string {
	const content = loadedSkillText("using-git-worktrees");
	const script = content.match(/```bash\n(verify_worktree_at_integration\(\) \{[\s\S]*?^}\n?)```/m)?.[1];
	if (!script) {
		throw new Error("using-git-worktrees has no executable immutable workspace guard");
	}
	return script;
}

function runWorktreeGuard(cwd: string, integrationSha: string): void {
	execFileSync(
		"bash",
		["-c", `${worktreeGuardScript()}\nverify_worktree_at_integration "$1"`, "worktree-guard", integrationSha],
		{ cwd, stdio: ["ignore", "pipe", "pipe"] },
	);
}

function expectWorktreeGuardFailure(cwd: string, integrationSha: string): void {
	expect(() => runWorktreeGuard(cwd, integrationSha)).toThrow();
}

interface PublicHostResponse {
	ok: boolean;
	action?: string;
	code?: string;
	commit?: string;
	grant?: string;
	operation?: string;
	red?: boolean;
	reason?: string;
	role?: string;
	authorizedImplementation?: boolean;
	state?: {
		deniedOperations: string[];
		authorizedImplementation: boolean;
	};
}

interface PublicHostIntentScenario {
	redObserved: boolean;
	deniedOperations: PublicHostResponse[];
	authorizedImplementation: boolean;
	restartState: {
		deniedOperations: string[];
		authorizedImplementation: boolean;
	};
}

function createPublicHostProcessSource(): string {
	return `import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsByName.set(process.argv[index], process.argv[index + 1]);
}
const mode = argumentsByName.get("--mode");
const repository = argumentsByName.get("--repository");
const store = argumentsByName.get("--store");
const skillsRoot = argumentsByName.get("--skills-root");
if (!mode || !repository || !store || !skillsRoot) {
  throw new Error("host fixture requires mode, repository, store, and skills-root");
}

function parseContract(filePath) {
  const content = readFileSync(filePath, "utf8");
  const contract = {};
  const tick = String.fromCharCode(96);
  const contractPattern = new RegExp("contract[^" + tick + "\\n]*" + tick + "([^" + tick + "]+)" + tick, "gi");
  for (const match of content.matchAll(contractPattern)) {
    for (const entry of match[1].split(";")) {
      const [key, value] = entry.trim().split("=", 2);
      if (key && value) contract[key] = value;
    }
  }
  return contract;
}

const contracts = {
  planner: parseContract(join(skillsRoot, "writing-plans", "SKILL.md")),
  designer: parseContract(join(skillsRoot, "brainstorming", "SKILL.md")),
  reviewer: parseContract(join(skillsRoot, "requesting-code-review", "SKILL.md")),
};
const forbiddenOperations = new Set(["write", "stage", "commit", "push"]);

function git(...args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function record(event) {
  const descriptor = openSync(store, "a", 0o600);
  try {
    appendFileSync(descriptor, JSON.stringify(event) + "\\n");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function events() {
  if (!existsSync(store)) return [];
  return readFileSync(store, "utf8")
    .split("\\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function state() {
  const storedEvents = events();
  return {
    deniedOperations: storedEvents
      .filter((event) => event.kind === "host-denied")
      .map((event) => event.role + ":" + event.operation)
      .sort(),
    authorizedImplementation: storedEvents.some((event) => event.kind === "authorized-implementation"),
  };
}

function deny(request, reason) {
  const response = {
    ok: false,
    code: "HOST_DENIED",
    grant: request.grant,
    role: request.role,
    operation: request.operation,
    reason,
  };
  record({ kind: "host-denied", grant: request.grant, role: request.role, operation: request.operation, reason });
  return response;
}

function handle(request) {
  if (request.action === "restart") return { ok: true, state: state() };
  if (request.action === "inspect" && request.role === "reviewer") {
    record({ kind: "read-only-inspection", role: request.role });
    return { ok: true, action: "inspect" };
  }
  if (mode === "red" && request.action === "attempt") {
    writeFileSync(join(repository, "forbidden-write.txt"), "unauthorized\\n");
    record({ kind: "RED-forbidden-write", role: request.role, operation: request.operation });
    return { ok: true, red: true };
  }
  if (request.action === "self-grant" && contracts[request.role]) {
    if (contracts[request.role].authority === "methodology-only") {
      return deny(request, "role contract is methodology-only");
    }
    return deny(request, "host grant is required");
  }
  if (request.action === "attempt" && contracts[request.role]) {
    if (forbiddenOperations.has(request.operation) && contracts[request.role][request.operation] === "none") {
      return deny(request, "role contract is methodology-only");
    }
    return deny(request, "host grant is required");
  }
  if (request.action === "implement") {
    if (request.role !== "host" || request.grant !== "write,stage,commit,push") {
      return deny({ role: request.role, operation: "implement" }, "host grant is required");
    }
    writeFileSync(join(repository, "product.txt"), request.value);
    git("add", "product.txt");
    const commit = git("commit", "-qm", "authorized implementation");
    git("push", "origin", "HEAD:refs/heads/integration");
    record({ kind: "authorized-implementation", commit });
    return { ok: true, action: "implement", commit };
  }
  return deny(request, "unsupported host request");
}

for (const line of readFileSync(0, "utf8").split("\\n").filter(Boolean)) {
  process.stdout.write(JSON.stringify(handle(JSON.parse(line))) + "\\n");
}
`;
}

function runPublicHostProcess(
	hostPath: string,
	options: { mode: "red" | "enforced"; repository: string; store: string },
	requests: Array<Record<string, string>>,
): PublicHostResponse[] {
	const output = execFileSync(
		process.execPath,
		[
			hostPath,
			"--mode",
			options.mode,
			"--repository",
			options.repository,
			"--store",
			options.store,
			"--skills-root",
			SUPERPOWERS_ROOT,
		],
		{
			input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
			encoding: "utf8",
		},
	);
	return output
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as PublicHostResponse);
}

function createPublicHostIntentScenario(): PublicHostIntentScenario {
	// Exercise the public host boundary in separate Node processes with real Git and an fsync-backed store.
	const fixtureRoot = mkdtempSync(join(tmpdir(), "superpowers-public-host-intent-"));
	const hostPath = join(fixtureRoot, "public-host.mjs");
	const redRepository = join(fixtureRoot, "red-repository");
	const redStore = join(fixtureRoot, "red-store.jsonl");
	const repository = join(fixtureRoot, "repository");
	const remote = join(fixtureRoot, "remote.git");
	const store = join(fixtureRoot, "store.jsonl");
	mkdirSync(redRepository, { recursive: true });
	mkdirSync(repository, { recursive: true });
	writeFileSync(hostPath, createPublicHostProcessSource());

	try {
		runGit(redRepository, ["init", "-q", "-b", "main"]);
		const redResponses = runPublicHostProcess(hostPath, { mode: "red", repository: redRepository, store: redStore }, [
			{ action: "attempt", role: "planner", operation: "write" },
		]);
		const redObserved =
			redResponses[0]?.ok === true &&
			redResponses[0]?.red === true &&
			existsSync(join(redRepository, "forbidden-write.txt")) &&
			readFileSync(redStore, "utf8").includes('"kind":"RED-forbidden-write"');

		runGit(repository, ["init", "-q", "-b", "main"]);
		runGit(repository, ["config", "user.email", "host-fixture@example.com"]);
		runGit(repository, ["config", "user.name", "Host Fixture"]);
		writeFileSync(join(repository, "README.md"), "baseline\n");
		runGit(repository, ["add", "README.md"]);
		runGit(repository, ["commit", "-qm", "baseline"]);
		runGit(fixtureRoot, ["init", "-q", "--bare", remote]);
		runGit(repository, ["remote", "add", "origin", remote]);
		const baselineHead = runGit(repository, ["rev-parse", "HEAD"]);
		const baselineStatus = runGit(repository, ["status", "--porcelain"]);

		const requests = (["planner", "designer", "reviewer"] as const).flatMap((role) => [
			{
				action: "self-grant",
				grant: "write,stage,commit,push",
				role,
				operation: "authority",
			},
			...(["write", "stage", "commit", "push"] as const).map((operation) => ({
				action: "attempt",
				grant: "write,stage,commit,push",
				role,
				operation,
			})),
		]);
		const deniedResponses = runPublicHostProcess(hostPath, { mode: "enforced", repository, store }, [
			...requests,
			{ action: "inspect", role: "reviewer" },
		]);
		const deniedOperations = deniedResponses.filter((response) => response.code === "HOST_DENIED");
		expect(deniedOperations.map((response) => `${response.role}:${response.operation}`).sort()).toEqual(
			requests.map((request) => `${request.role}:${request.operation}`).sort(),
		);
		expect(deniedOperations.every((response) => response.reason === "role contract is methodology-only")).toBe(true);
		expect(deniedOperations.every((response) => response.grant === "write,stage,commit,push")).toBe(true);
		expect(deniedResponses.some((response) => response.action === "inspect" && response.ok)).toBe(true);
		expect(existsSync(join(repository, "product.txt"))).toBe(false);
		expect(runGit(repository, ["rev-parse", "HEAD"])).toBe(baselineHead);
		expect(runGit(repository, ["status", "--porcelain"])).toBe(baselineStatus);
		expect(runGit(repository, ["ls-remote", "--heads", "origin", "refs/heads/integration"])).toBe("");

		const implementationResponse = runPublicHostProcess(hostPath, { mode: "enforced", repository, store }, [
			{
				action: "implement",
				role: "host",
				grant: "write,stage,commit,push",
				value: "authorized implementation\n",
			},
		])[0];
		const authorizedImplementation =
			implementationResponse?.ok === true &&
			existsSync(join(repository, "product.txt")) &&
			readFileSync(join(repository, "product.txt"), "utf8") === "authorized implementation\n" &&
			runGit(repository, ["status", "--porcelain"]) === "" &&
			runGit(repository, ["ls-remote", "--heads", "origin", "refs/heads/integration"]).includes(
				implementationResponse.commit ?? "__missing__",
			);

		const restartResponse = runPublicHostProcess(hostPath, { mode: "enforced", repository, store }, [
			{ action: "restart" },
		])[0];
		if (!restartResponse?.state) throw new Error("host restart did not return durable state");
		return { redObserved, deniedOperations, authorizedImplementation, restartState: restartResponse.state };
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
}

describe("vendored Superpowers skills", () => {
	it("matches the pinned upstream tree and retains provenance and licensing", () => {
		const files = listFiles(SUPERPOWERS_ROOT);
		const expectedFiles = Object.keys(EXPECTED_UPSTREAM_SHA256)
			.map((path) => (path.startsWith("skills/") ? path.slice("skills/".length) : path))
			.sort();

		expect(Object.keys(EXPECTED_FORK_SHA256).sort()).toEqual([...MODIFIED_UPSTREAM_FILES].sort());
		expect(files.filter((path) => !LOCAL_PROVENANCE_FILES.has(path))).toEqual(expectedFiles);
		const forbiddenFiles = files.filter((path) => /(^|\/)(?:\.git|cache|[^/]*plugin[^/]*)(?:\/|$)/i.test(path));
		expect(forbiddenFiles).toEqual([]);
		expect(files.some((path) => /(^|\/)(?:\.git|cache|[^/]*plugin[^/]*)(?:\/|$)/i.test(path))).toBe(false);
		for (const [sourcePath, expectedHash] of Object.entries(EXPECTED_UPSTREAM_SHA256)) {
			const destinationPath = sourcePath.startsWith("skills/") ? sourcePath.slice("skills/".length) : sourcePath;
			const forkHash = EXPECTED_FORK_SHA256[sourcePath];
			expect(sha256(join(SUPERPOWERS_ROOT, destinationPath))).toBe(forkHash ?? expectedHash);
			if (forkHash) {
				expect(forkHash).not.toBe(expectedHash);
			}
		}

		const license = readFileSync(join(SUPERPOWERS_ROOT, "LICENSE"), "utf8");
		expect(license).toContain("MIT License");
		expect(license).toContain("Copyright (c) 2025 Jesse Vincent");
		expect(license).toContain("Permission is hereby granted");

		const provenance = readFileSync(join(SUPERPOWERS_ROOT, "UPSTREAM.md"), "utf8");
		const patches = readFileSync(join(SUPERPOWERS_ROOT, "PATCHES.md"), "utf8");
		const source = JSON.parse(readFileSync(join(SUPERPOWERS_ROOT, "SOURCE.json"), "utf8")) as {
			name: string;
			version: string;
			sourceRepository: string;
			sourceCommit: string;
			supersedesSourceCommit: string;
			license: string;
			copyright: string;
			importedPaths: string[];
			includedPaths: string[];
			referenceOnlyPaths: string[];
			visualCompanion: { assetsIncluded: boolean; execution: string; runtimeCapability: string };
			licensePath: string;
		};
		const thirdPartyNotice = readFileSync(join(SUPERPOWERS_ROOT, "THIRD_PARTY_NOTICE.md"), "utf8");
		expect(provenance).toContain("https://github.com/obra/superpowers");
		expect(provenance).toContain(`Version: ${SUPERPOWERS_VERSION}`);
		expect(provenance).toContain(`Commit: \`${SUPERPOWERS_COMMIT}\``);
		expect(provenance).toContain("upstream `skills/**` and `LICENSE`");
		expect(provenance).toContain("intentional Prime Agent fork");
		expect(provenance).not.toContain("vendored byte-for-byte");
		expect(provenance).toContain("Local modifications must be explicit");
		expect(provenance).toContain("b6b58974aa8c731d7c160975959a0e62777975c6");
		expect(source).toMatchObject({
			name: "superpowers",
			version: SUPERPOWERS_VERSION,
			sourceRepository: "https://github.com/obra/superpowers",
			sourceCommit: SUPERPOWERS_COMMIT,
			supersedesSourceCommit: "b6b58974aa8c731d7c160975959a0e62777975c6",
			license: "MIT",
			copyright: "Copyright (c) 2025 Jesse Vincent",
			importedPaths: ["skills/**", "LICENSE"],
			includedPaths: ["skills/**/*.md"],
			referenceOnlyPaths: [
				"skills/**/scripts/**",
				"skills/**/*.sh",
				"skills/**/*.js",
				"skills/**/*.cjs",
				"skills/**/*.ts",
				"skills/**/*.html",
				"skills/**/*.dot",
			],
			visualCompanion: { assetsIncluded: true, execution: "denied", runtimeCapability: "unavailable" },
			licensePath: "LICENSE",
		});
		expect(thirdPartyNotice).toContain("https://github.com/obra/superpowers");
		expect(thirdPartyNotice).toContain(SUPERPOWERS_COMMIT);
		expect(thirdPartyNotice).toContain("b6b58974aa8c731d7c160975959a0e62777975c6");
		expect(thirdPartyNotice).toContain("LICENSE");
		expect(provenance).toContain("license must be retained");
		const documentedModifiedFiles = [...provenance.matchAll(/^- `(skills\/[^`]+)`$/gm)].map((match) => match[1]);
		expect(documentedModifiedFiles.sort()).toEqual([...MODIFIED_UPSTREAM_FILES].sort());
		const patchedFiles = [...patches.matchAll(/^- `(skills\/[^`]+)`:/gm)].map((match) => match[1]);
		expect(patchedFiles.sort()).toEqual([...MODIFIED_UPSTREAM_FILES].sort());
		for (const modifiedPath of MODIFIED_UPSTREAM_FILES) {
			expect(provenance).toContain(`- \`${modifiedPath}\``);
			expect(patches).toContain(`- \`${modifiedPath}\``);
		}
		expect(patches).toContain(`Superpowers ${SUPERPOWERS_VERSION}`);
		expect(patches).toContain(`Upstream baseline: \`${SUPERPOWERS_COMMIT}\``);
	});

	it("recursively discovers every manifest and resolves its local references", () => {
		const manifestPaths = listFiles(SUPERPOWERS_ROOT)
			.filter((path) => path.endsWith("/SKILL.md"))
			.map((path) => join(SUPERPOWERS_ROOT, ...path.split("/")));
		const discovery = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });
		const importedSkills = discovery.skills.filter((skill) => skill.filePath.startsWith(`${SUPERPOWERS_ROOT}${sep}`));
		const importedDiagnostics = discovery.diagnostics.filter((diagnostic) =>
			diagnostic.path?.startsWith(`${SUPERPOWERS_ROOT}${sep}`),
		);

		expect(manifestPaths).toHaveLength(14);
		expect(importedSkills.map((skill) => skill.filePath).sort()).toEqual(manifestPaths.sort());
		expect(importedDiagnostics).toEqual([]);

		const localReferences = manifestPaths.flatMap((manifestPath) => localReferencesForSkill(manifestPath));
		expect(localReferences).toHaveLength(25);
		const missingReferences = manifestPaths.flatMap((manifestPath) =>
			localReferencesForSkill(manifestPath)
				.filter((referencePath) => !readFileExists(referencePath))
				.map((referencePath) => `${manifestPath}: ${referencePath}`),
		);
		expect(missingReferences).toEqual([]);
	});

	it("requires canonical immutable review SHAs and verifies their ancestry", () => {
		const repository = mkdtempSync(join(tmpdir(), "superpowers-review-package-"));
		const unrelatedRepository = mkdtempSync(join(tmpdir(), "superpowers-review-unrelated-"));
		const outputRoot = mkdtempSync(join(tmpdir(), "superpowers-review-output-"));
		const reviewPackage = join(SUPERPOWERS_ROOT, "subagent-driven-development/scripts/review-package");
		const planPath = join(repository, "plan.md");
		const unrelatedPlanPath = join(unrelatedRepository, "plan.md");
		const outputPath = join(outputRoot, "review.diff");

		try {
			for (const cwd of [repository, unrelatedRepository]) {
				runGit(cwd, ["init", "-q"]);
				runGit(cwd, ["config", "user.email", "test@example.com"]);
				runGit(cwd, ["config", "user.name", "Review Fixture"]);
			}
			writeFileSync(planPath, "# Fixture plan\n");
			writeFileSync(unrelatedPlanPath, "# Unrelated plan\n");
			runGit(repository, ["add", "plan.md"]);
			runGit(repository, ["commit", "-qm", "integration"]);
			const integrationSha = runGit(repository, ["rev-parse", "HEAD"]);
			writeFileSync(join(repository, "candidate.txt"), "candidate\n");
			runGit(repository, ["add", "candidate.txt"]);
			runGit(repository, ["commit", "-qm", "candidate"]);
			const candidateSha = runGit(repository, ["rev-parse", "HEAD"]);
			runGit(unrelatedRepository, ["add", "plan.md"]);
			runGit(unrelatedRepository, ["commit", "-qm", "unrelated"]);
			const unrelatedSha = runGit(unrelatedRepository, ["rev-parse", "HEAD"]);
			const beforeHead = runGit(repository, ["rev-parse", "HEAD"]);
			const beforeStatus = runGit(repository, ["status", "--porcelain"]);

			execFileSync(reviewPackage, [planPath, integrationSha, candidateSha, integrationSha, outputPath], {
				cwd: repository,
				encoding: "utf8",
			});
			const packageText = readFileSync(outputPath, "utf8");
			expect(packageText).toContain(`Base SHA: ${integrationSha}`);
			expect(packageText).toContain(`Candidate SHA: ${candidateSha}`);
			expect(packageText).toContain(`Integration SHA: ${integrationSha}`);
			expect(packageText).toContain(
				`Review receipt binding: candidate=${candidateSha}; integration=${integrationSha}`,
			);
			expect(runGit(repository, ["rev-parse", "HEAD"])).toBe(beforeHead);
			expect(runGit(repository, ["status", "--porcelain"])).toBe(beforeStatus);

			expectReviewPackageFailure(repository, [planPath, integrationSha, candidateSha]);
			expectReviewPackageFailure(repository, [planPath, "HEAD", candidateSha, integrationSha, outputPath]);
			expectReviewPackageFailure(repository, [
				planPath,
				"refs/heads/main",
				candidateSha,
				integrationSha,
				outputPath,
			]);
			const uppercaseCandidateSha = candidateSha.replace(/[a-f]/, (value) => value.toUpperCase());
			expect(uppercaseCandidateSha).toMatch(/[A-F]/);
			expectReviewPackageFailure(repository, [
				planPath,
				integrationSha,
				uppercaseCandidateSha,
				integrationSha,
				outputPath,
			]);
			expectReviewPackageFailure(repository, [
				planPath,
				integrationSha.slice(0, -1),
				candidateSha,
				integrationSha,
				outputPath,
			]);
			expectReviewPackageFailure(repository, [planPath, unrelatedSha, candidateSha, integrationSha, outputPath]);
			expectReviewPackageFailure(repository, [planPath, integrationSha, candidateSha, unrelatedSha, outputPath]);
			expectReviewPackageFailure(repository, [planPath, candidateSha, integrationSha, integrationSha, outputPath]);
		} finally {
			rmSync(repository, { recursive: true, force: true });
			rmSync(unrelatedRepository, { recursive: true, force: true });
			rmSync(outputRoot, { recursive: true, force: true });
		}
	});

	it("rejects a sibling integration history even when both commits reach the candidate", () => {
		const repository = mkdtempSync(join(tmpdir(), "superpowers-review-ancestry-"));
		const planPath = join(repository, "plan.md");
		const outputPath = join(repository, "review.diff");

		try {
			runGit(repository, ["init", "-q"]);
			runGit(repository, ["config", "user.email", "test@example.com"]);
			runGit(repository, ["config", "user.name", "Review Fixture"]);
			writeFileSync(planPath, "# Fixture plan\n");
			runGit(repository, ["add", "plan.md"]);
			runGit(repository, ["commit", "-qm", "integration"]);
			const integrationSha = runGit(repository, ["rev-parse", "HEAD"]);

			runGit(repository, ["checkout", "-q", "--orphan", "base-root"]);
			runGit(repository, ["rm", "-rf", "."]);
			writeFileSync(join(repository, "base.txt"), "base\n");
			runGit(repository, ["add", "base.txt"]);
			runGit(repository, ["commit", "-qm", "base"]);
			const baseSha = runGit(repository, ["rev-parse", "HEAD"]);

			runGit(repository, ["checkout", "-q", "-b", "candidate"]);
			writeFileSync(join(repository, "candidate.txt"), "candidate\n");
			runGit(repository, ["add", "candidate.txt"]);
			runGit(repository, ["commit", "-qm", "candidate"]);
			runGit(repository, ["merge", "--allow-unrelated-histories", "--no-ff", "--no-edit", integrationSha]);
			const candidateSha = runGit(repository, ["rev-parse", "HEAD"]);
			writeFileSync(planPath, "# Fixture plan\n");

			expectReviewPackageFailure(repository, [planPath, baseSha, candidateSha, integrationSha, outputPath]);
		} finally {
			rmSync(repository, { recursive: true, force: true });
		}
	});

	it("executes the immutable worktree guard for existing, native, and fallback workspaces", () => {
		const repository = mkdtempSync(join(tmpdir(), "superpowers-worktree-guard-"));
		const worktreeParent = mkdtempSync(join(tmpdir(), "superpowers-worktree-paths-"));
		const correctPath = join(worktreeParent, "correct");
		const wrongPath = join(worktreeParent, "wrong");

		try {
			runGit(repository, ["init", "-q"]);
			runGit(repository, ["config", "user.email", "test@example.com"]);
			runGit(repository, ["config", "user.name", "Worktree Fixture"]);
			writeFileSync(join(repository, "integration.txt"), "integration\n");
			runGit(repository, ["add", "integration.txt"]);
			runGit(repository, ["commit", "-qm", "integration"]);
			const integrationSha = runGit(repository, ["rev-parse", "HEAD"]);
			writeFileSync(join(repository, "wrong.txt"), "wrong\n");
			runGit(repository, ["add", "wrong.txt"]);
			runGit(repository, ["commit", "-qm", "wrong base"]);
			const wrongSha = runGit(repository, ["rev-parse", "HEAD"]);

			runGit(repository, ["worktree", "add", "-q", correctPath, integrationSha]);
			runGit(repository, ["worktree", "add", "-q", wrongPath, wrongSha]);

			runWorktreeGuard(correctPath, integrationSha);
			expectWorktreeGuardFailure(wrongPath, integrationSha);
			expectWorktreeGuardFailure(correctPath, "HEAD");
			expectWorktreeGuardFailure(correctPath, "refs/heads/main");
		} finally {
			if (existsSync(correctPath)) {
				runGit(repository, ["worktree", "remove", "--force", correctPath]);
			}
			if (existsSync(wrongPath)) {
				runGit(repository, ["worktree", "remove", "--force", wrongPath]);
			}
			rmSync(worktreeParent, { recursive: true, force: true });
			rmSync(repository, { recursive: true, force: true });
		}
	});

	it("enforces read-only planning, design, and review through a durable host boundary", () => {
		const scenario = createPublicHostIntentScenario();
		expect(scenario.redObserved).toBe(true);
		const expectedDeniedOperations = (["planner", "designer", "reviewer"] as const).flatMap((role) =>
			["authority", "write", "stage", "commit", "push"].map((operation) => `${role}:${operation}`),
		);
		expect(scenario.deniedOperations.map((response) => `${response.role}:${response.operation}`).sort()).toEqual(
			expectedDeniedOperations.sort(),
		);
		expect(scenario.authorizedImplementation).toBe(true);
		expect(scenario.restartState).toMatchObject({
			deniedOperations: expectedDeniedOperations,
			authorizedImplementation: true,
		});
	});

	it("rejects residual review, worktree, capacity, and test-evidence shortcuts", () => {
		const reviewText = REVIEW_POLICY_FILES.map((path) => bundledFile(path)).join("\n");
		expect(reviewText).not.toMatch(/Subagent \(general-purpose\)|general-purpose subagent/i);
		expect(reviewText).not.toMatch(/\bgeneralist\b/i);
		expect(bundledFile("skills/requesting-code-review/SKILL.md")).toContain('[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]');
		expect(reviewText).not.toMatch(/\b(?:haiku|sonnet|opus)\b/i);
		expect(reviewText).not.toMatch(/\b(?:model|capacity)\s*[:=]\s*["']?(?:gpt|claude|general)/i);
		expect(bundledFile("skills/requesting-code-review/SKILL.md")).toContain(
			'git merge-base --is-ancestor "$INTEGRATION_SHA" "$BASE_SHA"',
		);
		expect(bundledFile("skills/requesting-code-review/code-reviewer.md")).toContain(
			"git merge-base --is-ancestor [INTEGRATION_SHA] [BASE_SHA]",
		);
		expect(bundledFile("skills/requesting-code-review/code-reviewer.md")).not.toContain("git worktree add");
		expect(bundledFile("skills/requesting-code-review/SKILL.md")).toContain("HOST-ASSIGNED LUNA CAPACITY HANDLE");
		expect(bundledFile("skills/requesting-code-review/code-reviewer.md")).toContain(
			"HOST-ASSIGNED LUNA CAPACITY HANDLE",
		);
		for (const path of [
			"skills/subagent-driven-development/implementer-prompt.md",
			"skills/subagent-driven-development/re-review-prompt.md",
			"skills/subagent-driven-development/task-reviewer-prompt.md",
		] as const) {
			expect(bundledFile(path)).toContain("HOST-ASSIGNED LUNA CAPACITY HANDLE");
		}

		const worktreeText = bundledFile("skills/using-git-worktrees/SKILL.md");
		expect(worktreeText).not.toMatch(/If the user declines|working in place|Sandbox fallback/i);
		expect(worktreeText).not.toMatch(/\.gitignore[^\n]*commit|commit[^\n]*\.gitignore/i);
		expect(worktreeText).toContain("explicit write grant");
		expect(worktreeText).not.toContain("npm test");
		const visualCompanionText = bundledFile("skills/brainstorming/visual-companion.md");
		expect(visualCompanionText).toContain("report that request to the host");
		expect(visualCompanionText).not.toMatch(/add .*\.gitignore/i);

		for (const path of INTENT_TEST_POLICY_FILES) {
			const text = bundledFile(path);
			expect(text).not.toMatch(
				/\b(?:18|1847)\s+tests?\b|all tests (?:passing|passed|clean)|comprehensive test coverage/i,
			);
			expect(text).not.toContain("npm test");
		}
		const intentPolicy = INTENT_TEST_POLICY_FILES.map((path) => bundledFile(path)).join("\n");
		expect(intentPolicy).toMatch(/public (?:host\/store\/process\/integration )?boundary/i);
		expect(intentPolicy).toMatch(
			/temporar(?:y(?:[/-]debugging-only|[\s\n]+(?:for[\s\n]+)?debugging)|ily[\s\n]+(?:for[\s\n]+)?debugging)/i,
		);
		expect(intentPolicy).toMatch(/mock-only-inadequate|mock-only.*inadequate/i);
		expect(intentPolicy).toMatch(/counts?[^\n]*(?:coverage|completion|GREEN)|coverage[^\n]*counts?/i);

		const writingSkillsText = listFiles(join(SUPERPOWERS_ROOT, "writing-skills"))
			.map((path) => readFileSync(join(SUPERPOWERS_ROOT, "writing-skills", path), "utf8"))
			.join("\n");
		expect(writingSkillsText).not.toMatch(/\b(?:haiku|sonnet|opus)\b/i);

		const allBundledText = listFiles(SUPERPOWERS_ROOT)
			.map((path) => readFileSync(join(SUPERPOWERS_ROOT, path), "utf8"))
			.join("\n");
		expect(allBundledText).not.toContain("unit-tests=temporary-supplemental");
		for (const path of UNIT_POLICY_FILES) {
			expect(bundledFile(path)).toMatch(
				/temporar(?:y(?:-debugging-only|[\s\n]+(?:for[\s\n]+)?debugging)|ily[\s\n]+(?:for[\s\n]+)?debugging)/i,
			);
		}
		expect(allBundledText).not.toMatch(/Subagent \(general-purpose\)|general-purpose subagent/i);
		expect(allBundledText).not.toMatch(/\bgeneralist\b|main\/master|before merge to main/i);
		expect(allBundledText).not.toMatch(/\b(?:haiku|sonnet|opus)\b|gpt-5\.6-(?:sol|terra)/i);
		expect(allBundledText).not.toMatch(/\bnpm test\b|\b(?:18|1847)\s+tests?\b|comprehensive test coverage/i);
	});

	it.each(POLICY_SCENARIOS)("$name", (scenario) => {
		expect(evaluatePolicyScenario(scenario)).toEqual(scenario.wanted);
	});

	it.each(IMPLEMENTATION_POLICY_SKILLS)("%s requires the shared intent-first TDD gates", (skillName) => {
		const contract = parseForkContract(skillName);
		expect({
			intent: contract.intent,
			forbiddenOutcomes: contract["forbidden-outcomes"],
			acceptance: contract.acceptance,
			red: contract.red,
			adversarialProbes: contract["adversarial-probes"],
			durability: contract.durability,
			adversarial: contract.adversarial,
			antiCheating: contract["anti-cheating"],
			unitTests: contract["unit-probes"] ?? contract["unit-tests"],
			mocks: contract.mocks,
			green: contract.green,
		}).toEqual({
			intent: "required",
			forbiddenOutcomes: "required",
			acceptance: expect.stringMatching(/^(?:black-box|public-intent)/),
			red: "observed-recorded-before-implementation",
			adversarialProbes: "regression-before-fix",
			durability: "real-store-process-restart",
			adversarial: "metamorphic,race,caller-mutation,locale,stale-replay",
			antiCheating: "required",
			unitTests: "temporary-debugging-only",
			mocks: "mock-only-inadequate",
			green: "independent-verification-adversarial-review",
		});
	});

	it.each(ROUTED_POLICY_SKILLS)("%s keeps authority in the host recipe", (skillName) => {
		const contract = parseForkContract(skillName);
		expect({
			authority: contract.authority,
			write: contract.write,
			commit: contract.commit,
			stage: contract.stage,
			push: contract.push,
			approval: contract.approval,
			merge: contract.merge,
			completion: contract.completion,
			capacity: contract.capacity,
		}).toEqual({
			authority: "methodology-only",
			write: "none",
			commit: "none",
			stage: "none",
			push: "none",
			approval: "none",
			merge: "none",
			completion: "none",
			capacity: "host-assigned-luna",
		});
		expect(["public-intent-boundary", "black-box-public-boundary", "public-process-boundary"]).toContain(
			contract.acceptance,
		);
		expect(contract["unit-probes"] ?? contract["unit-tests"]).toBe("temporary-debugging-only");
		expect(contract.mocks).toBe("mock-only-inadequate");
	});

	it("keeps every routed worker and reviewer prompt under host mutation authority", () => {
		for (const path of ROUTED_PROMPT_POLICY_FILES) {
			const content = bundledFile(path);
			expect(content).toContain("capacity=host-assigned-luna");
			expect(content).toContain("commit=none");
			expect(content).toContain("stage=none");
			expect(content).toContain("push=none");
		}
	});

	it("rejects a manifest reference that escapes the bundled root", () => {
		const fixtureRoot = mkdtempSync(join(SUPERPOWERS_ROOT, ".reference-boundary-"));
		const manifestPath = join(fixtureRoot, "skill", "SKILL.md");
		const bareManifestPath = join(fixtureRoot, "skill", "bare", "SKILL.md");
		mkdirSync(dirname(manifestPath), { recursive: true });
		mkdirSync(dirname(bareManifestPath), { recursive: true });
		writeFileSync(
			manifestPath,
			"---\nname: skill\ndescription: boundary fixture\n---\n\n[escape](../../../outside.md)\n",
		);
		writeFileSync(
			bareManifestPath,
			"---\nname: bare-skill\ndescription: boundary fixture\n---\n\nBare escape: ../../../../outside.md\n",
		);

		try {
			expect(() => localReferencesForSkill(manifestPath)).toThrow(/escapes bundled skill root/);
			expect(() => localReferencesForSkill(bareManifestPath)).toThrow(/escapes bundled skill root/);
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("declares the supported reference syntax and preserves all shipped file modes", () => {
		const provenance = readFileSync(join(SUPERPOWERS_ROOT, "UPSTREAM.md"), "utf8");
		for (const syntax of REFERENCE_SYNTAX) {
			expect(provenance).toContain(syntax);
		}
		for (const limit of REFERENCE_LIMITS) {
			expect(provenance).toContain(limit);
		}

		for (const path of listFiles(SUPERPOWERS_ROOT)) {
			const stats = lstatSync(join(SUPERPOWERS_ROOT, path));
			expect(stats.isFile()).toBe(true);
			expect(stats.isSymbolicLink()).toBe(false);
			const sourcePath = `skills/${path}`;
			const expectedMode = EXECUTABLE_UPSTREAM_FILES.has(sourcePath) ? 0o755 : 0o644;
			expect(stats.mode & 0o777).toBe(expectedMode);
		}
	});

	it("keeps a user skill ahead of the bundled fork skill at runtime", async () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "superpowers-collision-"));
		const agentDir = join(fixtureRoot, "agent");
		const cwd = join(fixtureRoot, "project");
		const userSkillPath = join(agentDir, "skills", "brainstorming", "SKILL.md");
		mkdirSync(dirname(userSkillPath), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(userSkillPath, "---\nname: brainstorming\ndescription: user override\n---\n\nUser skill.\n");

		try {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				bundledSkillsDir: getBundledSkillsDir(),
				settingsManager: SettingsManager.inMemory(),
			});
			await loader.reload();
			const result = loader.getSkills();
			const winner = result.skills.find((skill) => skill.name === "brainstorming");
			const collision = result.diagnostics.find(
				(diagnostic) => diagnostic.type === "collision" && diagnostic.collision?.name === "brainstorming",
			);

			expect(winner?.filePath).toBe(userSkillPath);
			expect(collision?.collision?.winnerPath).toBe(userSkillPath);
			expect(collision?.collision?.loserPath).toContain("/superpowers/brainstorming/SKILL.md");
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});

function readFileExists(filePath: string): boolean {
	return existsSync(filePath);
}
