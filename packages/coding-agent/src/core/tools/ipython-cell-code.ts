const BASH_CELL_MAGIC_PATTERN = /^((?:[ \t]*\r?\n)*)([ \t]*)%%bash\b([^\r\n]*)(\r?\n|$)/;

export interface ParsedIpythonBashCell {
	leadingWhitespace: string;
	indent: string;
	magicArguments: string;
	lineBreak: string;
	body: string;
}

export function parseIpythonBashCell(code: string): ParsedIpythonBashCell | undefined {
	const match = BASH_CELL_MAGIC_PATTERN.exec(code);
	if (!match) {
		return undefined;
	}
	return {
		leadingWhitespace: match[1] ?? "",
		indent: match[2] ?? "",
		magicArguments: match[3] ?? "",
		lineBreak: match[4] ?? "",
		body: code.slice(match[0].length),
	};
}

/** One-line teaching error for magic-style cells the Python REPL does not run, or undefined for plain Python. */
export function magicRejection(code: string): string | undefined {
	const firstLine = code
		.split("\n")
		.find((line) => line.trim().length > 0)
		?.trimStart();
	if (!firstLine) return undefined;
	if (firstLine.startsWith("%%bash")) {
		return "%%bash cells are not supported; use bash('cmd') / await bash('cmd')";
	}
	if (firstLine.startsWith("%%")) {
		return "%% cell magics are not supported; this is a plain Python REPL";
	}
	if (firstLine.startsWith("%cd")) {
		return "%cd is not supported; use os.chdir(...)";
	}
	if (firstLine.startsWith("%env")) {
		return "%env is not supported; use os.environ[...]";
	}
	if (firstLine.startsWith("%")) {
		return "% line magics are not supported; this is a plain Python REPL";
	}
	if (firstLine.startsWith("!")) {
		return "! shell escapes are not supported; use bash('cmd') / await bash('cmd')";
	}
	// Column-0 scan of every line; may false-positive on %-lines inside triple-quoted strings (accepted).
	for (const line of code.split("\n")) {
		if (line.startsWith("%cd")) {
			return "%cd is not supported; use os.chdir(...)";
		}
		if (line.startsWith("%env")) {
			return "%env is not supported; use os.environ[...]";
		}
		if (line.startsWith("!")) {
			return "! shell escapes are not supported; use bash('cmd') / await bash('cmd')";
		}
		if (line.startsWith("%")) {
			return "% line magics are not supported; this is a plain Python REPL";
		}
	}
	return undefined;
}
