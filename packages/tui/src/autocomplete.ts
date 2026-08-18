import { spawn } from "child_process";
import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { fuzzyFilter } from "./fuzzy.js";
import { getSlashCommandContext } from "./slash-command-context.js";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function toDisplayPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFdPathQuery(query: string): string {
	const normalized = toDisplayPath(query);
	if (!normalized.includes("/")) {
		return normalized;
	}

	const hasTrailingSeparator = normalized.endsWith("/");
	const trimmed = normalized.replace(/^\/+|\/+$/g, "");
	if (!trimmed) {
		return normalized;
	}

	const separatorPattern = "[\\\\/]";
	const segments = trimmed
		.split("/")
		.filter(Boolean)
		.map((segment) => escapeRegex(segment));
	if (segments.length === 0) {
		return normalized;
	}

	let pattern = segments.join(separatorPattern);
	if (hasTrailingSeparator) {
		pattern += separatorPattern;
	}
	return pattern;
}

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) {
			return i;
		}
	}
	return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) {
			return null;
		}
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) {
		return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	}
	if (prefix.startsWith('"')) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	}
	if (prefix.startsWith("@")) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	}
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

function buildCompletionValue(
	path: string,
	options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
): string {
	const needsQuotes = options.isQuotedPrefix || path.includes(" ");
	const prefix = options.isAtPrefix ? "@" : "";

	if (!needsQuotes) {
		return `${prefix}${path}`;
	}

	const openQuote = `${prefix}"`;
	const closeQuote = '"';
	return `${openQuote}${path}${closeQuote}`;
}

async function walkDirectoryWithFd(
	baseDir: string,
	fdPath: string,
	query: string,
	maxResults: number,
	signal: AbortSignal,
): Promise<Array<{ path: string; isDirectory: boolean }>> {
	const args = [
		"--base-directory",
		baseDir,
		"--max-results",
		String(maxResults),
		"--type",
		"f",
		"--type",
		"d",
		"--follow",
		"--hidden",
		"--exclude",
		".git",
		"--exclude",
		".git/*",
		"--exclude",
		".git/**",
	];

	if (toDisplayPath(query).includes("/")) {
		args.push("--full-path");
	}

	if (query) {
		args.push(buildFdPathQuery(query));
	}

	return await new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}

		const child = spawn(fdPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let resolved = false;

		const finish = (results: Array<{ path: string; isDirectory: boolean }>) => {
			if (resolved) return;
			resolved = true;
			signal.removeEventListener("abort", onAbort);
			resolve(results);
		};

		const onAbort = () => {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
			}
		};

		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			finish([]);
		});
		child.on("close", (code) => {
			if (signal.aborted || code !== 0 || !stdout) {
				finish([]);
				return;
			}

			const lines = stdout.trim().split("\n").filter(Boolean);
			const results: Array<{ path: string; isDirectory: boolean }> = [];

			for (const line of lines) {
				const displayLine = toDisplayPath(line);
				const hasTrailingSeparator = displayLine.endsWith("/");
				const normalizedPath = hasTrailingSeparator ? displayLine.slice(0, -1) : displayLine;
				if (normalizedPath === ".git" || normalizedPath.startsWith(".git/") || normalizedPath.includes("/.git/")) {
					continue;
				}

				results.push({
					path: displayLine,
					isDirectory: hasTrailingSeparator,
				});
			}

			finish(results);
		});
	});
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
	argumentHint?: string;
	sourceTag?: string;
	takesArgument?: boolean;
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	aliases?: readonly string[];
	description?: string;
	argumentHint?: string;
	sourceTag?: string;
	takesArgument?: boolean;
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}

export interface AutocompleteSuggestions {
	items: AutocompleteItem[];
	prefix: string; // What we're matching against (e.g., "/" or "src/")
	kind?: "slash-command" | "file";
}

export interface AutocompleteProvider {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};

	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

export class CombinedAutocompleteProvider implements AutocompleteProvider {
	private commands: (SlashCommand | AutocompleteItem)[];
	private basePath: string;
	private fdPath: string | null;

	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string, fdPath: string | null = null) {
		this.commands = commands;
		this.basePath = basePath;
		this.fdPath = fdPath;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const atPrefix = this.extractAtPrefix(textBeforeCursor);
		if (atPrefix) {
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
			const suggestions = await this.getFuzzyFileSuggestions(rawPrefix, {
				isQuotedPrefix,
				signal: options.signal,
			});
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: atPrefix,
				kind: "file",
			};
		}

		const slashContext = options.force ? null : getSlashCommandContext(lines, cursorLine, cursorCol);
		if (slashContext?.kind === "name") {
			const prefix = slashContext.prefix.slice(1);
			const commandItems = this.commands.map((cmd) => {
				const name = "name" in cmd ? cmd.name : cmd.value;
				const aliases = "aliases" in cmd && cmd.aliases ? cmd.aliases : [];
				const argumentHint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
				const sourceTag = "sourceTag" in cmd && cmd.sourceTag ? cmd.sourceTag : undefined;
				const takesArgument = "takesArgument" in cmd ? cmd.takesArgument === true : false;
				return {
					name,
					searchText: [name, ...aliases].join(" "),
					label: name,
					description: cmd.description,
					argumentHint,
					sourceTag,
					takesArgument,
				};
			});

			const filtered = fuzzyFilter(commandItems, prefix, (item) => item.searchText).map((item) => ({
				value: item.name,
				label: item.label,
				...(item.description && { description: item.description }),
				...(item.argumentHint && { argumentHint: item.argumentHint }),
				...(item.sourceTag && { sourceTag: item.sourceTag }),
				...(item.takesArgument && { takesArgument: true }),
			}));

			if (filtered.length > 0) {
				return {
					items: filtered,
					prefix: slashContext.prefix,
					kind: "slash-command",
				};
			}

			return null;
		} else if (slashContext?.kind === "argument") {
			const command = this.commands.find((cmd) => {
				const name = "name" in cmd ? cmd.name : cmd.value;
				return name === slashContext.commandName;
			});
			if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
				return null;
			}

			const argumentSuggestions = await command.getArgumentCompletions(slashContext.prefix);
			if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
				return null;
			}

			return {
				items: argumentSuggestions,
				prefix: slashContext.prefix,
			};
		}

		const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);
		if (pathMatch === null) {
			return null;
		}

		const suggestions = this.getFileSuggestions(pathMatch);
		if (suggestions.length === 0) return null;

		return {
			items: suggestions,
			prefix: pathMatch,
			kind: "file",
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);
		const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
		const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
		const hasTrailingQuoteInItem = item.value.endsWith('"');
		const adjustedAfterCursor =
			isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;
		const slashContext = getSlashCommandContext(lines, cursorLine, cursorCol);

		const isSlashCommand =
			slashContext?.kind === "name" &&
			slashContext.prefix === prefix &&
			this.commands.some((command) => ("name" in command ? command.name : command.value) === item.value);
		if (isSlashCommand) {
			const hasSeparatorAfterCursor = /^[ \t]/.test(adjustedAfterCursor);
			const separator = hasSeparatorAfterCursor ? "" : " ";
			const newLine = `${beforePrefix}/${item.value}${separator}${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2,
			};
		}

		if (prefix.startsWith("@")) {
			// Don't add space after directories so user can continue autocompleting
			const isDirectory = item.label.endsWith("/");
			const suffix = isDirectory ? "" : " ";
			const newLine = `${beforePrefix + item.value}${suffix}${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const hasTrailingQuote = item.value.endsWith('"');
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset + suffix.length,
			};
		}

		if (slashContext?.kind === "argument" && slashContext.prefix === prefix) {
			const newLine = beforePrefix + item.value + adjustedAfterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const isDirectory = item.label.endsWith("/");
			const hasTrailingQuote = item.value.endsWith('"');
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset,
			};
		}

		const newLine = beforePrefix + item.value + adjustedAfterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		const isDirectory = item.label.endsWith("/");
		const hasTrailingQuote = item.value.endsWith('"');
		const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + cursorOffset,
		};
	}

	private extractAtPrefix(text: string): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix?.startsWith('@"')) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;

		if (text[tokenStart] === "@") {
			return text.slice(tokenStart);
		}

		return null;
	}

	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

		if (forceExtract) {
			return pathPrefix;
		}

		// For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		if (pathPrefix === "" && text.endsWith(" ")) {
			return pathPrefix;
		}

		return null;
	}

	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (path === "~") {
			return homedir();
		}
		return path;
	}

	private resolveScopedFuzzyQuery(rawQuery: string): { baseDir: string; query: string; displayBase: string } | null {
		const normalizedQuery = toDisplayPath(rawQuery);
		const slashIndex = normalizedQuery.lastIndexOf("/");
		if (slashIndex === -1) {
			return null;
		}

		const displayBase = normalizedQuery.slice(0, slashIndex + 1);
		const query = normalizedQuery.slice(slashIndex + 1);

		let baseDir: string;
		if (displayBase.startsWith("~/")) {
			baseDir = this.expandHomePath(displayBase);
		} else if (displayBase.startsWith("/")) {
			baseDir = displayBase;
		} else {
			baseDir = join(this.basePath, displayBase);
		}

		try {
			if (!statSync(baseDir).isDirectory()) {
				return null;
			}
		} catch {
			return null;
		}

		return { baseDir, query, displayBase };
	}

	private scopedPathForDisplay(displayBase: string, relativePath: string): string {
		const normalizedRelativePath = toDisplayPath(relativePath);
		if (displayBase === "/") {
			return `/${normalizedRelativePath}`;
		}
		return `${toDisplayPath(displayBase)}${normalizedRelativePath}`;
	}

	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		try {
			let searchDir: string;
			let searchPrefix: string;
			const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
			let expandedPrefix = rawPrefix;

			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.expandHomePath(expandedPrefix);
			}

			const isRootPrefix =
				rawPrefix === "" ||
				rawPrefix === "./" ||
				rawPrefix === "../" ||
				rawPrefix === "~" ||
				rawPrefix === "~/" ||
				rawPrefix === "/" ||
				(isAtPrefix && rawPrefix === "");

			if (isRootPrefix) {
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (rawPrefix.endsWith("/")) {
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				const dir = dirname(expandedPrefix);
				const file = basename(expandedPrefix);
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = dir;
				} else {
					searchDir = join(this.basePath, dir);
				}
				searchPrefix = file;
			}

			const entries = readdirSync(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						const fullPath = join(searchDir, entry.name);
						isDirectory = statSync(fullPath).isDirectory();
					} catch {
						// Ignore broken or inaccessible symbolic links.
					}
				}

				let relativePath: string;
				const name = entry.name;
				const displayPrefix = rawPrefix;

				if (displayPrefix.endsWith("/")) {
					relativePath = displayPrefix + name;
				} else if (displayPrefix.includes("/") || displayPrefix.includes("\\")) {
					if (displayPrefix.startsWith("~/")) {
						const homeRelativeDir = displayPrefix.slice(2); // Remove ~/
						const dir = dirname(homeRelativeDir);
						relativePath = `~/${dir === "." ? name : join(dir, name)}`;
					} else if (displayPrefix.startsWith("/")) {
						const dir = dirname(displayPrefix);
						if (dir === "/") {
							relativePath = `/${name}`;
						} else {
							relativePath = `${dir}/${name}`;
						}
					} else {
						relativePath = join(dirname(displayPrefix), name);
						if (displayPrefix.startsWith("./") && !relativePath.startsWith("./")) {
							relativePath = `./${relativePath}`;
						}
					}
				} else {
					if (displayPrefix.startsWith("~")) {
						relativePath = `~/${name}`;
					} else {
						relativePath = name;
					}
				}

				relativePath = toDisplayPath(relativePath);
				const pathValue = isDirectory ? `${relativePath}/` : relativePath;
				const value = buildCompletionValue(pathValue, {
					isDirectory,
					isAtPrefix,
					isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: name + (isDirectory ? "/" : ""),
				});
			}

			suggestions.sort((a, b) => {
				const aIsDir = a.value.endsWith("/");
				const bIsDir = b.value.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions;
		} catch (_e) {
			return [];
		}
	}

	private scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
		const fileName = basename(filePath);
		const lowerFileName = fileName.toLowerCase();
		const lowerQuery = query.toLowerCase();

		let score = 0;

		if (lowerFileName === lowerQuery) score = 100;
		else if (lowerFileName.startsWith(lowerQuery)) score = 80;
		else if (lowerFileName.includes(lowerQuery)) score = 50;
		else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;

		if (isDirectory && score > 0) score += 10;

		return score;
	}

	private async getFuzzyFileSuggestions(
		query: string,
		options: { isQuotedPrefix: boolean; signal: AbortSignal },
	): Promise<AutocompleteItem[]> {
		if (!this.fdPath || options.signal.aborted) {
			return [];
		}

		try {
			const scopedQuery = this.resolveScopedFuzzyQuery(query);
			const fdBaseDir = scopedQuery?.baseDir ?? this.basePath;
			const fdQuery = scopedQuery?.query ?? query;
			const entries = await walkDirectoryWithFd(fdBaseDir, this.fdPath, fdQuery, 100, options.signal);
			if (options.signal.aborted) {
				return [];
			}

			const scoredEntries = entries
				.map((entry) => ({
					...entry,
					score: fdQuery ? this.scoreEntry(entry.path, fdQuery, entry.isDirectory) : 1,
				}))
				.filter((entry) => entry.score > 0);

			scoredEntries.sort((a, b) => b.score - a.score);
			const topEntries = scoredEntries.slice(0, 20);

			const suggestions: AutocompleteItem[] = [];
			for (const { path: entryPath, isDirectory } of topEntries) {
				const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
				const displayPath = scopedQuery
					? this.scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
					: pathWithoutSlash;
				const entryName = basename(pathWithoutSlash);
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				const value = buildCompletionValue(completionPath, {
					isDirectory,
					isAtPrefix: true,
					isQuotedPrefix: options.isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: entryName + (isDirectory ? "/" : ""),
					description: displayPath,
				});
			}

			return suggestions;
		} catch {
			return [];
		}
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return getSlashCommandContext(lines, cursorLine, cursorCol)?.kind !== "name";
	}
}
