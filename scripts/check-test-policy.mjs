#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const testFilePattern =
	/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)vitest\.config\.[cm]?[jt]s$|^prime-agent-runtime\/test\/.*\.py$/;

function git(args, allowFailure = false) {
	try {
		return execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", allowFailure ? "ignore" : "inherit"],
		}).trim();
	} catch (error) {
		if (allowFailure) return "";
		throw error;
	}
}

function resolveBase() {
	if (process.env.TEST_POLICY_BASE && git(["rev-parse", "--verify", process.env.TEST_POLICY_BASE], true)) {
		return process.env.TEST_POLICY_BASE;
	}
	if (process.env.GITHUB_BASE_REF) {
		const remote = `origin/${process.env.GITHUB_BASE_REF}`;
		if (git(["rev-parse", "--verify", remote], true)) return git(["merge-base", "HEAD", remote], true) || remote;
	}
	const originMain = git(["rev-parse", "--verify", "origin/main"], true);
	const head = git(["rev-parse", "HEAD"]);
	if (originMain && originMain !== head) return git(["merge-base", "HEAD", "origin/main"], true) || "origin/main";
	return git(["rev-parse", "--verify", "HEAD^"], true) ? "HEAD^" : undefined;
}

function walkFiles(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (["node_modules", ".git", "dist"].includes(entry)) continue;
		const path = resolve(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) walkFiles(path, out);
		else {
			const rel = relative(root, path).replaceAll("\\", "/");
			if (testFilePattern.test(rel)) out.push(rel);
		}
	}
	return out;
}

function maskJsSyntax(content) {
	let quote;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	let masked = "";
	for (let index = 0; index < content.length; index += 1) {
		const char = content[index];
		const next = content[index + 1];
		if (lineComment) {
			if (char === "\n") {
				lineComment = false;
				masked += "\n";
			} else masked += " ";
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				masked += "  ";
				blockComment = false;
				index += 1;
			} else masked += char === "\n" ? "\n" : " ";
			continue;
		}
		if (quote) {
			masked += char === "\n" ? "\n" : " ";
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === "/" && next === "/") {
			masked += "  ";
			lineComment = true;
			index += 1;
		} else if (char === "/" && next === "*") {
			masked += "  ";
			blockComment = true;
			index += 1;
		} else if (char === '"' || char === "'" || char === "`") {
			masked += " ";
			quote = char;
		} else masked += char;
	}
	return masked;
}

function directObjectProperties(argument) {
	const names = new Set();
	const numeric = new Set();
	if (!argument.trimStart().startsWith("{")) return { names, numeric };
	const record = (name, separator) => {
		names.add(name);
		if (argument[separator] !== ":") return;
		let value = separator + 1;
		while (/\s/.test(argument[value] ?? "")) value += 1;
		if (/^[1-9][0-9_]*/.test(argument.slice(value))) numeric.add(name);
	};
	let depth = 0;
	let cursor = 0;
	let previous = "";
	while (cursor < argument.length) {
		const char = argument[cursor];
		const next = argument[cursor + 1];
		if (char === "/" && next === "/") {
			cursor = argument.indexOf("\n", cursor + 2);
			if (cursor < 0) break;
			continue;
		}
		if (char === "/" && next === "*") {
			const closing = argument.indexOf("*/", cursor + 2);
			cursor = closing < 0 ? argument.length : closing + 2;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			const quote = char;
			let name = "";
			let escaped = false;
			cursor += 1;
			while (cursor < argument.length) {
				const quoted = argument[cursor];
				if (escaped) escaped = false;
				else if (quoted === "\\") escaped = true;
				else if (quoted === quote) break;
				else name += quoted;
				cursor += 1;
			}
			let lookahead = cursor + 1;
			while (/\s/.test(argument[lookahead] ?? "")) lookahead += 1;
			if (depth === 1 && (previous === "{" || previous === ",") && argument[lookahead] === ":") record(name, lookahead);
			previous = "string";
			cursor += 1;
			continue;
		}
		if (char === "{") depth += 1;
		else if (char === "}") depth -= 1;
		else if (depth === 1 && /[A-Za-z_$]/.test(char) && (previous === "{" || previous === ",")) {
			const name = argument.slice(cursor).match(/^[A-Za-z_$][\w$]*/)?.[0];
			if (name) {
				let lookahead = cursor + name.length;
				while (/\s/.test(argument[lookahead] ?? "")) lookahead += 1;
				if ([":", ",", "}"].includes(argument[lookahead])) record(name, lookahead);
				cursor += name.length;
				previous = "identifier";
				continue;
			}
		}
		if (!/\s/.test(char)) previous = char;
		cursor += 1;
	}
	return { names, numeric };
}

function changedTestFiles(base) {
	if (!base) return [...walkFiles(resolve(root, "packages")), ...walkFiles(resolve(root, "prime-agent-runtime", "test"))];
	const roots = ["packages", "prime-agent-runtime/test", "scripts"];
	const tracked = git(["diff", "--name-only", "--diff-filter=ACMR", base, "--", ...roots]);
	const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...roots], true);
	return [...new Set(`${tracked}\n${untracked}`.split("\n"))].filter(
		(path) => path && testFilePattern.test(path) && existsSync(resolve(root, path)),
	);
}

function scan(content, path = "") {
	const lines = content.split("\n");
	const maskedContent = maskJsSyntax(content);
	const maskedLines = maskedContent.split("\n");
	const violations = [];
	const isVitestConfig = /(?:^|\/)vitest\.config\.[cm]?[jt]s$/.test(path);
	let title = "<module>";
	const add = (category, line, detail, explicitTitle = title) => {
		const previous = lines[line - 2]?.trim() ?? "";
		const suppression = previous.match(/^(?:\/\/|#) test-policy: allow ([a-z-]+) -- (.+)$/);
		if (suppression?.[1] === category && suppression[2].trim().length >= 12) return;
		violations.push({ category, detail, identity: `${category}\0${explicitTitle}\0${detail}`, line, title: explicitTitle });
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const maskedLine = maskedLines[index];
		const matchOutsideSyntax = (pattern) => {
			const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
			for (const match of line.matchAll(new RegExp(pattern.source, flags))) {
				if (/\S/.test(maskedLine.slice(match.index ?? 0, (match.index ?? 0) + match[0].length))) return match;
			}
			return undefined;
		};
		const titleMatch = line.match(/\b(?:it|test)(?:\.[A-Za-z]+|\([^)]*\))*\(\s*["'`]([^"'`]+)/);
		const pythonTitleMatch = line.match(/^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)/);
		if (titleMatch) title = titleMatch[1];
		else if (pythonTitleMatch) title = pythonTitleMatch[1];
		const modifier = maskedLine.match(
			/\b(?:it|test|describe|suite|context)(?:\.[A-Za-z]+|\([^)]*\))*\.(skipIf|runIf|skip|todo|only|fails)\b|\b(xit|xtest|xdescribe)\s*\(/,
		);
		if (modifier) {
			const callStart = lines.slice(index, index + 4).join(" ");
			const ownTitle = callStart.match(/["'`]([^"'`]+)["'`]/)?.[1] ?? title;
			add("conditional-or-disabled-test", index + 1, `.${modifier[1] ?? modifier[2]}`, ownTitle);
		}
		const bracketModifier = matchOutsideSyntax(/\b(?:it|test|describe|suite|context)\s*\[\s*["'](skipIf|runIf|skip|todo|only|fails)["']\s*\]/);
		if (bracketModifier) add("conditional-or-disabled-test", index + 1, `[${bracketModifier[1]}]`);
		const pythonModifier = line.match(/@(?:unittest\.)?(skipIf|skipUnless|skip)\b|@pytest\.mark\.(skipif|skip)\b/);
		const pythonDecoratorTitle =
			lines
				.slice(index, index + 4)
				.join(" ")
				.match(/\bdef\s+(test_[A-Za-z0-9_]+)/)?.[1] ?? title;
		if (pythonModifier) add("conditional-or-disabled-test", index + 1, pythonModifier[0], pythonDecoratorTitle);
		if (/@pytest\.mark\.(?:flaky|repeat)\b/.test(line)) add("test-retry", index + 1, line.trim(), pythonDecoratorTitle);
		if (/@pytest\.mark\.timeout\b/.test(line)) add("explicit-test-timeout", index + 1, "pytest timeout marker", pythonDecoratorTitle);
		const testStart = line.match(/^(\s*)(?:it|test|describe|suite|context)(?:\.[A-Za-z]+|\([^)]*\))*\s*(?:\(|`)/);
		if (testStart) {
			const indent = testStart[1];
			let header = lines.slice(index, index + 80).join("\n");
			if (/\.each\s*\(/.test(line)) {
				header = "";
				for (let cursor = index; cursor < lines.length; cursor += 1) {
					const closure = lines[cursor].match(/[)\]]\)\s*\(/);
					if (!closure) continue;
					header = [lines[cursor].slice((closure.index ?? 0) + closure[0].length - 1), ...lines.slice(cursor + 1, cursor + 80)].join("\n");
					break;
				}
			} else if (/\.each\s*`/.test(line)) {
				const tagged = lines.slice(index, index + 200).join("\n");
				const opening = tagged.indexOf("`");
				let escaped = false;
				for (let cursor = opening + 1; cursor < tagged.length; cursor += 1) {
					if (escaped) {
						escaped = false;
						continue;
					}
					if (tagged[cursor] === "\\") {
						escaped = true;
						continue;
					}
					if (tagged[cursor] !== "`") continue;
					const callStart = tagged.indexOf("(", cursor + 1);
					if (callStart >= 0) header = tagged.slice(callStart, callStart + 10_000);
					break;
				}
			}
			const maskedHeader = maskJsSyntax(header);
			const opening = maskedHeader.indexOf("(");
			let parentheses = 0;
			let braces = 0;
			let brackets = 0;
			let lastArgumentComma = opening;
			let callbackIndex = -1;
			let callEnd = maskedHeader.length;
			for (let cursor = opening; cursor >= 0 && cursor < maskedHeader.length; cursor += 1) {
				const char = maskedHeader[cursor];
				if (char === "(") parentheses += 1;
				else if (char === ")") {
					parentheses -= 1;
					if (parentheses === 0) {
						callEnd = cursor;
						break;
					}
				} else if (char === "{") braces += 1;
				else if (char === "}") braces -= 1;
				else if (char === "[") brackets += 1;
				else if (char === "]") brackets -= 1;
				else if (parentheses === 1 && braces === 0 && brackets === 0) {
					if (char === ",") lastArgumentComma = cursor;
					const functionToken = maskedHeader.slice(cursor).match(/^function\b/);
					if (maskedHeader.startsWith("=>", cursor) || functionToken) {
						callbackIndex = lastArgumentComma + 1;
						break;
					}
				}
			}
			const optionsEnd = callbackIndex >= 0 ? callbackIndex : callEnd;
			const optionsRegion = header.slice(0, optionsEnd);
			const argumentsBeforeCallback = [];
			let argumentStart = opening + 1;
			parentheses = 1;
			braces = 0;
			brackets = 0;
			for (let cursor = opening + 1; cursor <= optionsEnd; cursor += 1) {
				const char = maskedHeader[cursor];
				if (char === "(") parentheses += 1;
				else if (char === ")") parentheses -= 1;
				else if (char === "{") braces += 1;
				else if (char === "}") braces -= 1;
				else if (char === "[") brackets += 1;
				else if (char === "]") brackets -= 1;
				if ((char === "," && parentheses === 1 && braces === 0 && brackets === 0) || cursor === optionsEnd) {
					argumentsBeforeCallback.push(header.slice(argumentStart, cursor));
					argumentStart = cursor + 1;
				}
			}
			const optionNames = new Set();
			for (const argument of argumentsBeforeCallback) {
				for (const name of directObjectProperties(argument).names) optionNames.add(name);
			}
			const hasOption = (name) => optionNames.has(name);
			const ownTitle = optionsRegion.match(/["'`]([^"'`]+)["'`]/)?.[1] ?? title;
			if (hasOption("retry")) add("test-retry", index + 1, "retry option", ownTitle);
			if (hasOption("timeout")) add("explicit-test-timeout", index + 1, "per-test timeout option", ownTitle);
			const disabledOption = ["skip", "todo", "only", "fails"].find((name) => hasOption(name));
			if (disabledOption) add("conditional-or-disabled-test", index + 1, `${disabledOption} option`, ownTitle);
			if (/,\s*\d[\d_]*\s*\)\s*;?\s*$/.test(line)) add("explicit-test-timeout", index + 1, "numeric timeout argument", ownTitle);
			if (!/\)\s*;?\s*$/.test(line)) for (let cursor = index; cursor < lines.length; cursor += 1) {
				const candidate = lines[cursor];
				const candidateTail = candidate.startsWith(indent) ? candidate.slice(indent.length) : undefined;
				if (candidateTail && /^},\s*\d[\d_]*\s*\)\s*;?\s*$/.test(candidateTail)) {
					add("explicit-test-timeout", cursor + 1, "numeric timeout argument", ownTitle);
					break;
				}
				const next = lines[cursor + 1] ?? "";
				const nextTail = next.startsWith(indent) ? next.slice(indent.length) : undefined;
				if (candidateTail && /^\s*\d[\d_]*\s*,?\s*$/.test(candidateTail) && next === `${indent});`) {
					add("explicit-test-timeout", cursor + 1, "multiline numeric timeout argument", ownTitle);
					break;
				}
				if (candidate === `${indent}},` && nextTail && /^\d[\d_]*\s*,?\s*$/.test(nextTail) && (lines[cursor + 2] ?? "").trim() === ");") {
					add("explicit-test-timeout", cursor + 1, "multiline numeric timeout argument", ownTitle);
					break;
				}
				if (cursor > index && (candidate === `${indent}});` || candidate === `${indent});`)) break;
			}
		}
		if (!isVitestConfig && /\b(?:testTimeout|hookTimeout)\s*:/.test(maskedLines[index])) {
			add("explicit-test-timeout", index + 1, "timeout option", "<module config>");
		}
		if (matchOutsideSyntax(/\b(?:expect\.poll|vi\.waitFor|waitForTimeout)\s*\(/)) {
			add("wall-clock-poll", index + 1, line.match(/(?:expect\.poll|vi\.waitFor|waitForTimeout)/)?.[0] ?? "poll");
		}
		if (matchOutsideSyntax(/\b(?:sleep|delay)\s*\(/) && !/\b(?:sleep|delay)\s*[:=]/.test(maskedLine)) {
			add("wall-clock-sleep", index + 1, "sleep/delay call");
		}
		if (matchOutsideSyntax(/\b(?:setTimeout|setInterval)\s*\(/)) add("wall-clock-timer", index + 1, "setTimeout/setInterval");
		if (matchOutsideSyntax(/\bAtomics\.wait\s*\(/)) add("wall-clock-timer", index + 1, "Atomics.wait");
		const controlWindow = maskedLines.slice(index, index + 4).join(" ");
		if (
			/\bif\s*\([^)]*(?:process\.env|apiKey|credential|token|process\.platform|os\.(?:environ|getenv)|sys\.platform)/i.test(maskedLine) &&
			/\b(?:return|continue)\b/.test(controlWindow)
		) {
			add("environment-gated-path", index + 1, "conditional early exit");
		}
		if (matchOutsideSyntax(/\b[A-Za-z_$][\w$.[\]]*\s*&&\s*expect\s*\(/)) {
			add("optional-assertion", index + 1, "short-circuited assertion");
		}
		if (matchOutsideSyntax(/\bexpect\s*\(\s*(?:true|false|[-+]?\d+(?:\.\d+)?|["'][^"']*["'])\s*\)/)) {
			add("vacuous-assertion", index + 1, "literal expect");
		}
	}

	for (const match of maskedContent.matchAll(/\.(?:listen|bind)\s*\(/g)) {
		let argument = (match.index ?? 0) + match[0].length;
		while (/\s/.test(maskedContent[argument] ?? "")) argument += 1;
		let fixed = /^[1-9][0-9_]*/.test(maskedContent.slice(argument));
		if (!fixed && maskedContent[argument] === "{") {
			let depth = 0;
			let closing = -1;
			for (let cursor = argument; cursor < maskedContent.length; cursor += 1) {
				if (maskedContent[cursor] === "{") depth += 1;
				else if (maskedContent[cursor] === "}" && --depth === 0) {
					closing = cursor;
					break;
				}
			}
			if (closing >= 0) fixed = directObjectProperties(content.slice(argument, closing + 1)).numeric.has("port");
		}
		if (fixed) {
			const line = maskedContent.slice(0, match.index ?? 0).split("\n").length;
			add("fixed-resource", line, "fixed bind/listen port", "<network resource>");
		}
	}

	if (isVitestConfig) {
		const findClosingBrace = (opening) => {
			let depth = 0;
			for (let cursor = opening; cursor >= 0 && cursor < maskedContent.length; cursor += 1) {
				if (maskedContent[cursor] === "{") depth += 1;
				else if (maskedContent[cursor] === "}" && --depth === 0) return cursor;
			}
			return -1;
		};
		const directSurface = (opening, closing) => {
			let depth = 0;
			let surface = " ".repeat(content.length);
			const chars = surface.split("");
			for (let cursor = opening; cursor <= closing; cursor += 1) {
				const depthBefore = depth;
				if (maskedContent[cursor] === "{") depth += 1;
				if (depthBefore <= 1) chars[cursor] = content[cursor];
				if (maskedContent[cursor] === "}") depth -= 1;
			}
			return chars.join("");
		};
		const defineConfig = maskedContent.search(/\bdefineConfig\s*\(/);
		const exportDefault = maskedContent.search(/\bexport\s+default\b/);
		const rootStart = defineConfig >= 0 ? defineConfig : exportDefault;
		const rootOpening = rootStart >= 0 ? maskedContent.indexOf("{", rootStart) : -1;
		const rootClosing = findClosingBrace(rootOpening);
		if (rootOpening >= 0 && rootClosing >= 0) {
			const rootSurface = directSurface(rootOpening, rootClosing);
			const testProperty = rootSurface.slice(rootOpening, rootClosing + 1).match(/(?:\btest\b|["']test["'])\s*:\s*\{/);
			if (testProperty?.index !== undefined) {
				const testPropertyStart = rootOpening + testProperty.index;
				const testOpening = content.indexOf("{", testPropertyStart);
				const testClosing = findClosingBrace(testOpening);
				const configNames = directObjectProperties(content.slice(testOpening, testClosing + 1)).names;
				const line = content.slice(0, testOpening).split("\n").length;
				if (configNames.has("retry")) add("test-retry", line, "config retry option", "<vitest config>");
				if (configNames.has("testTimeout") || configNames.has("hookTimeout")) {
					add("explicit-test-timeout", line, "config timeout option", "<vitest config>");
				}
			}
		}
	}

	return violations;
}

function counts(violations) {
	const result = new Map();
	for (const violation of violations) result.set(violation.identity, (result.get(violation.identity) ?? 0) + 1);
	return result;
}

function changedLineStats(base) {
	if (!base) return undefined;
	const stats = { sourceAdded: 0, testAdded: 0, testDeleted: 0 };
	const tracked = new Set();
	const isSource = (path) =>
		((!path.includes("/") && /\.(?:[cm]?[jt]sx?|py|sh)$/.test(path)) || /(?:^|\/)(?:src|scripts)\//.test(path)) &&
		!testFilePattern.test(path);
	const meaningfulSourceFlags = (lines, path) => {
		const normalized = /\.(?:py|sh)$/.test(path) ? lines : maskJsSyntax(lines.join("\n")).split("\n");
		return normalized
			.map((line) => line.trim())
			.map((line) => line.length > 0 && !/^#/.test(line) && !/^[{}()[\],;]+$/.test(line));
	};
	const meaningfulSourceCount = (lines, path) => meaningfulSourceFlags(lines, path).filter(Boolean).length;
	const record = (path, added, deleted) => {
		tracked.add(path);
		if (testFilePattern.test(path)) {
			stats.testAdded += added;
			stats.testDeleted += deleted;
		}
	};
	const roots = ["."];
	for (const row of git(["diff", "--numstat", "--no-renames", base, "--", ...roots]).split("\n")) {
		if (!row) continue;
		const [added, deleted, path] = row.split("\t");
		if (/^\d+$/.test(added) && /^\d+$/.test(deleted)) record(path, Number(added), Number(deleted));
	}
	let sourcePath;
	let addedSourceLines = [];
	let newLine = 0;
	const flushSource = () => {
		if (sourcePath && existsSync(resolve(root, sourcePath))) {
			const flags = meaningfulSourceFlags(readFileSync(resolve(root, sourcePath), "utf8").split("\n"), sourcePath);
			for (const line of addedSourceLines) if (flags[line - 1]) stats.sourceAdded += 1;
		}
		addedSourceLines = [];
	};
	for (const line of git(["diff", "--unified=0", "--no-renames", base, "--", ...roots]).split("\n")) {
		if (line.startsWith("+++ ")) {
			flushSource();
			const path = line.slice(4).replace(/^b\//, "");
			sourcePath = isSource(path) ? path : undefined;
			continue;
		}
		const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			newLine = Number(hunk[1]);
			continue;
		}
		if (!sourcePath || !line || line.startsWith("diff --git") || line.startsWith("--- ")) continue;
		if (line.startsWith("+")) {
			addedSourceLines.push(newLine);
			newLine += 1;
		} else if (!line.startsWith("-") && !line.startsWith("\\")) newLine += 1;
	}
	flushSource();
	const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...roots], true);
	for (const path of untracked.split("\n")) {
		if (!path || tracked.has(path) || !existsSync(resolve(root, path))) continue;
		const content = readFileSync(resolve(root, path), "utf8");
		const added = content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
		record(path, added, 0);
		if (isSource(path)) stats.sourceAdded += meaningfulSourceCount(content.split("\n"), path);
	}
	return stats;
}

const base = resolveBase();
const failures = [];
const lineStats = changedLineStats(base);
if (lineStats && lineStats.testAdded - lineStats.testDeleted > lineStats.sourceAdded) {
	failures.push({
		path: "<test-line-budget>",
		line: 0,
		category: "excess-test-lines",
		title: "changed test LOC",
		detail: `net test additions ${lineStats.testAdded - lineStats.testDeleted} exceed source additions ${lineStats.sourceAdded}`,
	});
}
for (const path of changedTestFiles(base)) {
	const current = scan(readFileSync(resolve(root, path), "utf8"), path);
	const oldContent = base ? git(["show", `${base}:${path}`], true) : "";
	const allowed = counts(oldContent ? scan(oldContent, path) : []);
	const seen = new Map();
	for (const violation of current) {
		const count = (seen.get(violation.identity) ?? 0) + 1;
		seen.set(violation.identity, count);
		if (count > (allowed.get(violation.identity) ?? 0)) failures.push({ path, ...violation });
	}
}

if (failures.length > 0) {
	console.error("New test-policy violations:\n");
	for (const failure of failures) console.error(`${failure.path}:${failure.line} [${failure.category}] ${failure.title}: ${failure.detail}`);
	console.error("\nUse a deterministic signal, deferred promise, fake timer, or unconditional local fixture instead.");
	process.exit(1);
}
console.log(`Test policy check passed${base ? ` against ${base}` : ""}.`);
