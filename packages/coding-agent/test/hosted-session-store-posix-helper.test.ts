import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HELPER = fileURLToPath(
	new URL("../src/modes/daemon/sandbox/hosted-session-store-posix-helper.py", import.meta.url),
);

interface PythonFunction {
	header: string;
	body: string;
	startLine: number;
}

function pythonFunction(source: string, name: string): PythonFunction {
	const lines = source.split("\n");
	const prefix = `def ${name}(`;
	let start = -1;
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index]?.startsWith(prefix) === true) {
			start = index;
			break;
		}
	}
	if (start < 0) return { header: "", body: "", startLine: 0 };
	let headerEnd = start;
	while (headerEnd < lines.length && lines[headerEnd]?.endsWith(":") !== true) headerEnd += 1;
	let end = headerEnd + 1;
	while (end < lines.length) {
		const line = lines[end] ?? "";
		if (/^(def|class) [A-Za-z0-9_]+/.test(line)) break;
		end += 1;
	}
	return {
		header: lines.slice(start, headerEnd + 1).join("\n"),
		body: lines.slice(headerEnd + 1, end).join("\n"),
		startLine: start + 1,
	};
}

function pythonClass(source: string, name: string): string {
	const lines = source.split("\n");
	const prefix = `class ${name}:`;
	const start = lines.indexOf(prefix);
	if (start < 0) return "";
	let end = start + 1;
	while (end < lines.length) {
		const line = lines[end] ?? "";
		if (/^(def|class) [A-Za-z0-9_]+/.test(line)) break;
		end += 1;
	}
	return lines.slice(start + 1, end).join("\n");
}

function count(text: string, token: string): number {
	let found = 0;
	let offset = 0;
	while (offset <= text.length) {
		const index = text.indexOf(token, offset);
		if (index < 0) break;
		found += 1;
		offset = index + token.length;
	}
	return found;
}

function replaceUnique(text: string, anchor: string, replacement: string): string {
	if (anchor.length === 0 || count(text, anchor) !== 1) return "";
	return text.replace(anchor, replacement);
}

function mutatePythonFunction(source: string, functionName: string, anchor: string, replacement: string): string {
	const found = pythonFunction(source, functionName);
	if (found.startLine === 0 || count(source, found.body) !== 1) return "";
	const mutatedBody = replaceUnique(found.body, anchor, replacement);
	if (mutatedBody.length === 0) return "";
	return source.replace(found.body, mutatedBody);
}

function tokensInOrder(text: string, tokens: readonly string[]): boolean {
	let prior = -1;
	for (const token of tokens) {
		const index = text.indexOf(token, prior + 1);
		if (index <= prior) return false;
		prior = index;
	}
	return true;
}

function indentation(line: string): number {
	const match = /^(\s*)/.exec(line);
	return match?.[1]?.length ?? 0;
}

function branchBody(body: string, marker: string): string {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => line.includes(marker));
	if (start < 0) return "";
	const baseIndent = indentation(lines[start] ?? "");
	let end = start + 1;
	while (end < lines.length) {
		const line = lines[end] ?? "";
		if (line.trim().length > 0 && indentation(line) <= baseIndent) break;
		end += 1;
	}
	return lines.slice(start + 1, end).join("\n");
}

interface PurgeStageCountRow {
	generationStage: string;
	ledgerStage: string;
	minimumWalCount: number;
	maximumWalCount: number;
	minimumLedgerCount: number;
	maximumLedgerCount: number;
}

function purgeStageCountRows(body: string): PurgeStageCountRow[] {
	const rows: PurgeStageCountRow[] = [];
	const pattern = /^\s*\("([a-z-]+)", "([a-z-]+)", (\d+), (\d+), (\d+), (\d+)\),$/gm;
	for (const match of body.matchAll(pattern)) {
		const generationStage = match[1];
		const ledgerStage = match[2];
		const minimumWalCount = match[3];
		const maximumWalCount = match[4];
		const minimumLedgerCount = match[5];
		const maximumLedgerCount = match[6];
		if (
			generationStage !== undefined &&
			ledgerStage !== undefined &&
			minimumWalCount !== undefined &&
			maximumWalCount !== undefined &&
			minimumLedgerCount !== undefined &&
			maximumLedgerCount !== undefined
		) {
			rows.push({
				generationStage,
				ledgerStage,
				minimumWalCount: Number(minimumWalCount),
				maximumWalCount: Number(maximumWalCount),
				minimumLedgerCount: Number(minimumLedgerCount),
				maximumLedgerCount: Number(maximumLedgerCount),
			});
		}
	}
	return rows;
}

function tableAllowsPurge(
	rows: readonly PurgeStageCountRow[],
	generationStage: string,
	ledgerStage: string,
	walCount: number,
	ledgerCount: number,
): boolean {
	for (const row of rows) {
		if (
			row.generationStage === generationStage &&
			row.ledgerStage === ledgerStage &&
			row.minimumWalCount <= walCount &&
			walCount <= row.maximumWalCount &&
			row.minimumLedgerCount <= ledgerCount &&
			ledgerCount <= row.maximumLedgerCount
		) {
			return true;
		}
	}
	return false;
}

interface PurgeCommandState {
	walFirstRevision: number;
	walHead: boolean;
	walDirectory: boolean;
	generationDirectory: boolean;
	generationsDirectory: boolean;
	ledgerFirstOrdinal: number;
	ledgerTerminalOrdinal: number;
	ledgerHead: boolean;
	ledgerDirectory: boolean;
	lifecycleHead: boolean;
	identity: boolean;
	lifecycleDirectory: boolean;
	absenceProved: boolean;
}

function newPurgeState(ledgerTerminalOrdinal: number): PurgeCommandState {
	return {
		walFirstRevision: 1,
		walHead: true,
		walDirectory: true,
		generationDirectory: true,
		generationsDirectory: true,
		ledgerFirstOrdinal: 0,
		ledgerTerminalOrdinal,
		ledgerHead: true,
		ledgerDirectory: true,
		lifecycleHead: true,
		identity: true,
		lifecycleDirectory: true,
		absenceProved: false,
	};
}

function advancePurgeCommand(state: PurgeCommandState): string | null {
	if (state.walFirstRevision < 7) {
		state.walFirstRevision += 1;
		return "remove-older-wal";
	}
	if (state.ledgerFirstOrdinal < state.ledgerTerminalOrdinal) {
		state.ledgerFirstOrdinal += 1;
		return "remove-older-ledger";
	}
	if (state.walHead) {
		state.walHead = false;
		return "unlink-wal-head";
	}
	if (state.walFirstRevision === 7) {
		state.walFirstRevision = 8;
		return "unlink-wal-terminal";
	}
	if (state.walDirectory) {
		state.walDirectory = false;
		return "rmdir-wal";
	}
	if (state.generationDirectory) {
		state.generationDirectory = false;
		return "rmdir-generation";
	}
	if (state.generationsDirectory) {
		state.generationsDirectory = false;
		return "rmdir-generations";
	}
	if (state.ledgerHead) {
		state.ledgerHead = false;
		return "unlink-ledger-head";
	}
	if (state.ledgerFirstOrdinal === state.ledgerTerminalOrdinal) {
		state.ledgerFirstOrdinal += 1;
		return "unlink-ledger-terminal";
	}
	if (state.ledgerDirectory) {
		state.ledgerDirectory = false;
		return "rmdir-ledger";
	}
	if (state.lifecycleHead) {
		state.lifecycleHead = false;
		return "unlink-lifecycle-head";
	}
	if (state.identity) {
		state.identity = false;
		return "unlink-identity";
	}
	if (state.lifecycleDirectory) {
		state.lifecycleDirectory = false;
		return "rmdir-lifecycle";
	}
	if (!state.absenceProved) {
		state.absenceProved = true;
		return "probe-absence";
	}
	return null;
}

function purgeGenerationStage(state: PurgeCommandState): string {
	if (!state.generationsDirectory) return "absent";
	if (!state.generationDirectory) return "empty-generations";
	if (!state.walDirectory) return "empty-generation";
	const walCount = Math.max(0, 8 - state.walFirstRevision);
	if (walCount === 0) return "empty-wal";
	if (!state.walHead) return "terminal-record";
	return state.walFirstRevision === 1 ? "full-head" : "suffix-head";
}

function purgeLedgerStage(state: PurgeCommandState): string {
	if (!state.ledgerDirectory) return "absent";
	const ledgerCount = Math.max(0, state.ledgerTerminalOrdinal - state.ledgerFirstOrdinal + 1);
	if (ledgerCount === 0) return "empty";
	if (!state.ledgerHead) return "terminal-record";
	return state.ledgerFirstOrdinal === 0 ? "full-head" : "suffix-head";
}

function purgeStateKey(state: PurgeCommandState): string {
	const walCount = state.walDirectory ? Math.max(0, 8 - state.walFirstRevision) : 0;
	const ledgerCount = state.ledgerDirectory
		? Math.max(0, state.ledgerTerminalOrdinal - state.ledgerFirstOrdinal + 1)
		: 0;
	return `${purgeGenerationStage(state)}|${purgeLedgerStage(state)}|${walCount}|${ledgerCount}`;
}

function derivedPurgeStates(): Set<string> {
	const result = new Set<string>();
	for (let terminal = 1; terminal < 16; terminal += 1) {
		const state = newPurgeState(terminal);
		while (advancePurgeCommand(state) !== null) {
			if (!state.lifecycleHead) break;
			result.add(purgeStateKey(state));
		}
	}
	return result;
}

function derivedPurgeOperationOrder(): string[] {
	const state = newPurgeState(15);
	const operations: string[] = [];
	while (true) {
		const operation = advancePurgeCommand(state);
		if (operation === null) break;
		const prior = operations[operations.length - 1];
		if (operation !== prior) operations.push(operation);
	}
	return operations;
}

interface PurgeSourceOperation {
	marker: string;
	operation: string;
}

interface SourceMutation {
	functionName: string;
	anchor: string;
	replacement: string;
}

const PURGE_SOURCE_OPERATIONS: readonly PurgeSourceOperation[] = [
	{ marker: "_remove_older_records(wal_fd, generation[3], wal_terminal_name)", operation: "remove-older-wal" },
	{ marker: "_remove_older_records(ledger_fd, ledger_rows, ledger_terminal_name)", operation: "remove-older-ledger" },
	{ marker: "_unlink(wal_fd, _HEAD)", operation: "unlink-wal-head" },
	{ marker: "_unlink(wal_fd, wal_terminal_name)", operation: "unlink-wal-terminal" },
	{ marker: "_rmdir(generation_fd, _WAL)", operation: "rmdir-wal" },
	{ marker: "_rmdir(generations_fd, generation[0])", operation: "rmdir-generation" },
	{ marker: "_rmdir(lifecycle_fd, _GENERATIONS)", operation: "rmdir-generations" },
	{ marker: "_unlink(ledger_fd, _HEAD)", operation: "unlink-ledger-head" },
	{ marker: "_unlink(ledger_fd, ledger_terminal_name)", operation: "unlink-ledger-terminal" },
	{ marker: "_rmdir(lifecycle_fd, _LEDGER)", operation: "rmdir-ledger" },
	{ marker: "_unlink(lifecycle_fd, _HEAD)", operation: "unlink-lifecycle-head" },
	{ marker: "_unlink(lifecycle_fd, _IDENTITY)", operation: "unlink-identity" },
	{ marker: "_rmdir(root_fd, lifecycle_name)", operation: "rmdir-lifecycle" },
	{ marker: "_probe_absent(root_fd, lifecycle_name)", operation: "probe-absence" },
];

const PURGE_RECOVERY_MUTATIONS: readonly SourceMutation[] = [
	{ functionName: "_recover_purge_suffix", anchor: "if _HEAD not in entries:", replacement: "if _HEAD in entries:" },
	{
		functionName: "_recover_purge_suffix",
		anchor: "if _contains_temp(entries):",
		replacement: "if not _contains_temp(entries):",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if _IDENTITY not in entries:",
		replacement: "if _IDENTITY in entries:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if _contains_outside(entries, (_IDENTITY, _LEDGER, _GENERATIONS, _HEAD)):",
		replacement: "if not _contains_outside(entries, (_IDENTITY, _LEDGER, _GENERATIONS, _HEAD)):",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if not _same(identity_digest, head_identity):",
		replacement: "if _same(identity_digest, head_identity):",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: 'ledger_stage = "absent"\n        if _LEDGER in entries:',
		replacement: 'ledger_stage = "absent"\n        if _LEDGER not in entries:',
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "ledger_head_present = _HEAD in ledger_entries",
		replacement: "ledger_head_present = _HEAD not in ledger_entries",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if _contains_temp(ledger_entries):",
		replacement: "if not _contains_temp(ledger_entries):",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if ledger_number != ledger_rows[-1][0] or not _same(ledger_head_digest, ledger_rows[-1][3]):",
		replacement: "if ledger_number == ledger_rows[-1][0] or not _same(ledger_head_digest, ledger_rows[-1][3]):",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if ledger_rows[0][0] == 0:\n                    if not _same(identity, ledger_rows[0][2])",
		replacement: "if ledger_rows[0][0] != 0:\n                    if not _same(identity, ledger_rows[0][2])",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "elif len(ledger_rows) == 1:",
		replacement: "elif len(ledger_rows) == 2:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "elif len(ledger_rows) == 0:",
		replacement: "elif len(ledger_rows) < 0:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor:
			'else:\n            if _GENERATIONS in entries:\n                raise Fatal(_E_STATE)\n            ledger_stage = "absent"',
		replacement:
			'else:\n            if _GENERATIONS not in entries:\n                raise Fatal(_E_STATE)\n            ledger_stage = "absent"',
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "current_name = _hex_name(current_generation)\n        if _GENERATIONS in entries:",
		replacement: "current_name = _hex_name(current_generation)\n        if _GENERATIONS not in entries:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if len(generation_names) == 0:",
		replacement: "if len(generation_names) == 1:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "elif len(generation_names) == 2:",
		replacement: "elif len(generation_names) == 3:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "elif len(generation_names) == 1 and generation_names[0] == current_name:",
		replacement: "elif len(generation_names) == 1 and generation_names[0] != current_name:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if len(generation_entries) == 0:",
		replacement: "if len(generation_entries) == 1:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "elif generation_entries == [_WAL]:",
		replacement: "elif generation_entries != [_WAL]:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if _contains_temp(wal_entries):",
		replacement: "if not _contains_temp(wal_entries):",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: 'if wal_head_present and wal_rows[0][0] == 1 and ledger_stage == "full-head":',
		replacement: 'if wal_head_present and wal_rows[0][0] == 1 and ledger_stage != "full-head":',
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if terminal_state != _W_ABSENT:",
		replacement: "if terminal_state == _W_ABSENT:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if wal_rows[-1][0] != current_revision or not _same(wal_rows[-1][3], current_digest):",
		replacement: "if wal_rows[-1][0] == current_revision or not _same(wal_rows[-1][3], current_digest):",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "wal_head_present = _HEAD in wal_entries",
		replacement: "wal_head_present = _HEAD not in wal_entries",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: 'generation_stage = "full-head" if wal_rows[0][0] == 1 else "suffix-head"',
		replacement: 'generation_stage = "full-head" if wal_rows[0][0] != 1 else "suffix-head"',
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "elif len(wal_rows) == 1:",
		replacement: "elif len(wal_rows) == 2:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "elif len(wal_rows) == 0:",
		replacement: "elif len(wal_rows) < 0:",
	},
	{ functionName: "_recover_purge_suffix", anchor: "candidate = False", replacement: "candidate = True" },
	{ functionName: "_recover_purge_suffix", anchor: "if not candidate:", replacement: "if candidate:" },
	{
		functionName: "_recover_purge_suffix",
		anchor: "if len(wal_rows) > 0 and wal_rows[-1][0] != _MAX_WAL_RECORDS:",
		replacement: "if len(wal_rows) > 0 and wal_rows[-1][0] == _MAX_WAL_RECORDS:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if len(ledger_rows) > 0 and (ledger_rows[-1][0] < 1 or ledger_rows[-1][0] >= _MAX_LEDGER_RECORDS):",
		replacement: "if len(ledger_rows) > 0 and (ledger_rows[-1][0] < 0 or ledger_rows[-1][0] >= _MAX_LEDGER_RECORDS):",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if len(ledger_rows) > 0 and (ledger_rows[-1][0] < 1 or ledger_rows[-1][0] >= _MAX_LEDGER_RECORDS):",
		replacement: "if len(ledger_rows) > 0 and (ledger_rows[-1][0] < 1 or ledger_rows[-1][0] > _MAX_LEDGER_RECORDS):",
	},
	{
		functionName: "_scan_suffix_records",
		anchor: "        first_number,\n        maximum_count,",
		replacement: "        0,\n        maximum_count,",
	},
	{
		functionName: "_scan_records",
		anchor: "if records[index][0] != first_number + index:",
		replacement: "if records[index][0] == first_number + index:",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if not _purge_stage_pair_allowed(generation_stage, ledger_stage, len(wal_rows), len(ledger_rows)):",
		replacement: "if _purge_stage_pair_allowed(generation_stage, ledger_stage, len(wal_rows), len(ledger_rows)):",
	},
	{
		functionName: "_recover_purge_suffix",
		anchor: "if set(entries) != {_IDENTITY, _HEAD}:",
		replacement: "if set(entries) == {_IDENTITY, _HEAD}:",
	},
];

const PURGE_TABLE_ROW_MUTATIONS: readonly SourceMutation[] = [
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: '("suffix-head", "full-head", 1, 6, 2, 16)',
		replacement: '("suffix-head", "full-head", 0, 6, 2, 16)',
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: '("suffix-head", "suffix-head", 1, 1, 1, 15)',
		replacement: '("suffix-head", "suffix-head", 1, 2, 1, 15)',
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: '("terminal-record", "suffix-head", 1, 1, 1, 1)',
		replacement: '("terminal-record", "suffix-head", 0, 1, 1, 1)',
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: '("empty-wal", "suffix-head", 0, 0, 1, 1)',
		replacement: '("empty-wal", "suffix-head", 0, 1, 1, 1)',
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: '("empty-generation", "suffix-head", 0, 0, 1, 1)',
		replacement: '("empty-generation", "suffix-head", 0, 1, 1, 1)',
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: '("empty-generations", "suffix-head", 0, 0, 1, 1)',
		replacement: '("empty-generations", "suffix-head", 0, 1, 1, 1)',
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: '("absent", "suffix-head", 0, 0, 1, 1)',
		replacement: '("absent", "suffix-head", 0, 0, 1, 2)',
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: '("absent", "terminal-record", 0, 0, 1, 1)',
		replacement: '("absent", "terminal-record", 0, 0, 0, 1)',
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: '("absent", "empty", 0, 0, 0, 0)',
		replacement: '("absent", "empty", 0, 0, 0, 1)',
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: '("absent", "absent", 0, 0, 0, 0)',
		replacement: '("absent", "absent", 0, 0, 1, 1)',
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: "generation_stage == row[0]",
		replacement: "generation_stage != row[0]",
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: "and ledger_stage == row[1]",
		replacement: "and ledger_stage != row[1]",
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: "and row[2] <= wal_count <= row[3]",
		replacement: "and row[2] < wal_count <= row[3]",
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: "and row[2] <= wal_count <= row[3]",
		replacement: "and row[2] <= wal_count < row[3]",
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: "and row[4] <= ledger_count <= row[5]",
		replacement: "and row[4] < ledger_count <= row[5]",
	},
	{
		functionName: "_purge_stage_pair_allowed",
		anchor: "and row[4] <= ledger_count <= row[5]",
		replacement: "and row[4] <= ledger_count < row[5]",
	},
];

function purgeCommandOperationOrder(body: string): string[] {
	const found: string[] = [];
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		for (const candidate of PURGE_SOURCE_OPERATIONS) {
			if (trimmed === candidate.marker) found.push(candidate.operation);
		}
	}
	return found;
}

function purgeCommandMatchesModel(body: string): boolean {
	return JSON.stringify(purgeCommandOperationOrder(body)) === JSON.stringify(derivedPurgeOperationOrder());
}

function purgeRecoveryClassifierIsExact(source: string): boolean {
	const body = pythonFunction(source, "_recover_purge_suffix").body;
	if (body.length === 0) return false;
	const bodies = new Map<string, string>();
	for (const mutation of PURGE_RECOVERY_MUTATIONS) {
		if (!bodies.has(mutation.functionName)) {
			bodies.set(mutation.functionName, pythonFunction(source, mutation.functionName).body);
		}
		const inspected = bodies.get(mutation.functionName);
		if (inspected === undefined || count(inspected, mutation.anchor) !== 1) return false;
	}
	const assignments = [
		'ledger_stage = "full-head"',
		'ledger_stage = "suffix-head"',
		'ledger_stage = "terminal-record"',
		'ledger_stage = "empty"',
		'generation_stage = "empty-generations"',
		'generation_stage = "empty-generation"',
		'generation_stage = "full-head" if wal_rows[0][0] == 1 else "suffix-head"',
		'generation_stage = "terminal-record"',
		'generation_stage = "empty-wal"',
	];
	for (const assignment of assignments) {
		if (count(body, assignment) !== 1) return false;
	}
	return tokensInOrder(body, [
		'ledger_stage = "absent"',
		"if _LEDGER in entries:",
		"ledger_head_present = _HEAD in ledger_entries",
		"if ledger_head_present:",
		"if ledger_rows[0][0] == 0:",
		'ledger_stage = "full-head"',
		'ledger_stage = "suffix-head"',
		"elif len(ledger_rows) == 1:",
		'ledger_stage = "terminal-record"',
		"elif len(ledger_rows) == 0:",
		'ledger_stage = "empty"',
		"if _GENERATIONS in entries:",
		'ledger_stage = "absent"',
		'generation_stage = "absent"',
		"if _GENERATIONS in entries:",
		"if len(generation_names) == 0:",
		'generation_stage = "empty-generations"',
		"elif len(generation_names) == 1 and generation_names[0] == current_name:",
		"if len(generation_entries) == 0:",
		'generation_stage = "empty-generation"',
		"elif generation_entries == [_WAL]:",
		"wal_head_present = _HEAD in wal_entries",
		"if wal_head_present:",
		'generation_stage = "full-head" if wal_rows[0][0] == 1 else "suffix-head"',
		"elif len(wal_rows) == 1:",
		'generation_stage = "terminal-record"',
		"elif len(wal_rows) == 0:",
		'generation_stage = "empty-wal"',
		'generation_stage = "absent"',
		"_purge_stage_pair_allowed(generation_stage, ledger_stage, len(wal_rows), len(ledger_rows))",
	]);
}

function exactPurgeAdmission(body: string): boolean {
	const rows = purgeStageCountRows(body);
	const derived = derivedPurgeStates();
	if (rows.length === 0 || derived.size === 0) return false;
	const generationStages = [
		"full-head",
		"suffix-head",
		"terminal-record",
		"empty-wal",
		"empty-generation",
		"empty-generations",
		"absent",
		"unknown",
	];
	const ledgerStages = ["full-head", "suffix-head", "terminal-record", "empty", "absent", "unknown"];
	for (const generationStage of generationStages) {
		for (const ledgerStage of ledgerStages) {
			for (let walCount = 0; walCount <= 7; walCount += 1) {
				for (let ledgerCount = 0; ledgerCount <= 16; ledgerCount += 1) {
					const key = `${generationStage}|${ledgerStage}|${walCount}|${ledgerCount}`;
					if (tableAllowsPurge(rows, generationStage, ledgerStage, walCount, ledgerCount) !== derived.has(key)) {
						return false;
					}
				}
			}
		}
	}
	return (
		count(body, "generation_stage == row[0]") === 1 &&
		count(body, "ledger_stage == row[1]") === 1 &&
		count(body, "row[2] <= wal_count <= row[3]") === 1 &&
		count(body, "row[4] <= ledger_count <= row[5]") === 1
	);
}

function inventoryResponseGuard(body: string): string {
	const lines = body.split("\n");
	const allocation = lines.findIndex((line) => line.includes("session_response = _session_payload("));
	if (allocation < 0) return "";
	let ownershipTry = allocation + 1;
	while (ownershipTry < lines.length && (lines[ownershipTry] ?? "").trim().length === 0) ownershipTry += 1;
	const tryLine = lines[ownershipTry] ?? "";
	if (tryLine.trim() !== "try:") return "";
	const tryIndent = indentation(tryLine);
	let finallyLine = ownershipTry + 1;
	while (finallyLine < lines.length) {
		const line = lines[finallyLine] ?? "";
		if (line.trim() === "finally:" && indentation(line) === tryIndent) break;
		if (line.trim().length > 0 && indentation(line) <= tryIndent) return "";
		finallyLine += 1;
	}
	if (finallyLine >= lines.length) return "";
	const cleanup = lines[finallyLine + 1] ?? "";
	if (cleanup.trim() !== "_zero(session_response)" || indentation(cleanup) <= tryIndent) return "";
	return lines.slice(ownershipTry + 1, finallyLine).join("\n");
}

function createPrefixAllowed(stages: readonly boolean[]): boolean {
	let missing = false;
	for (const present of stages) {
		if (!present) missing = true;
		else if (missing) return false;
	}
	return true;
}

type CreateDisposition = "exists" | "complete" | "fatal";

function createDisposition(
	lifecycleHead: boolean,
	stages: readonly boolean[],
	publishedTreeValid: boolean,
	requestMatchesPartial: boolean,
	extraEntry: boolean,
): CreateDisposition {
	if (extraEntry) return "fatal";
	if (lifecycleHead) return publishedTreeValid ? "exists" : "fatal";
	if (!requestMatchesPartial || !createPrefixAllowed(stages)) return "fatal";
	return "complete";
}

type CreatePublicationTarget = "identity" | "ledger-record" | "ledger-head" | "wal-record" | "wal-head";

interface CreatePublicationTargetSpec {
	target: CreatePublicationTarget;
	stageIndex: number;
	parentBaseEntries: number;
}

const CREATE_PUBLICATION_TARGETS: readonly CreatePublicationTargetSpec[] = [
	{ target: "identity", stageIndex: 0, parentBaseEntries: 0 },
	{ target: "ledger-record", stageIndex: 2, parentBaseEntries: 0 },
	{ target: "ledger-head", stageIndex: 3, parentBaseEntries: 1 },
	{ target: "wal-record", stageIndex: 7, parentBaseEntries: 0 },
	{ target: "wal-head", stageIndex: 8, parentBaseEntries: 1 },
];

interface CreatePublicationState {
	target: CreatePublicationTarget;
	targetPresent: boolean;
	tempPresent: boolean;
	sameInode: boolean;
	linkCount: number;
	contentMatches: boolean;
	metadataMatches: boolean;
	laterStagePresent: boolean;
	publishedPrefixLength: number;
	parentEntryCount: number;
}

function createTargetSpec(target: CreatePublicationTarget): CreatePublicationTargetSpec | undefined {
	for (const candidate of CREATE_PUBLICATION_TARGETS) {
		if (candidate.target === target) return candidate;
	}
	return undefined;
}

function createPublicationDisposition(source: string, state: CreatePublicationState): CreateDisposition {
	if (!createPublicationSourceIsExact(source)) return "fatal";
	const spec = createTargetSpec(state.target);
	if (spec === undefined) return "fatal";
	const targetCount = state.targetPresent ? 1 : 0;
	const tempCount = state.tempPresent ? 1 : 0;
	const expectedPrefixLength = spec.stageIndex + targetCount;
	const expectedEntryCount = spec.parentBaseEntries + targetCount + tempCount;
	if (state.publishedPrefixLength !== expectedPrefixLength || state.parentEntryCount !== expectedEntryCount) {
		return "fatal";
	}
	if (state.targetPresent && state.tempPresent && state.laterStagePresent) return "fatal";
	if (!state.targetPresent && !state.tempPresent) return "complete";
	if (!state.targetPresent && state.tempPresent) {
		return state.linkCount === 1 && state.metadataMatches ? "complete" : "fatal";
	}
	if (state.targetPresent && !state.tempPresent) {
		return state.linkCount === 1 && state.contentMatches && state.metadataMatches ? "complete" : "fatal";
	}
	if (
		state.targetPresent &&
		state.tempPresent &&
		state.sameInode &&
		state.linkCount === 2 &&
		state.contentMatches &&
		state.metadataMatches
	) {
		return "complete";
	}
	return "fatal";
}

function createPublicationFixtures(target: CreatePublicationTarget): CreatePublicationState[] {
	const spec = createTargetSpec(target);
	if (spec === undefined) return [];
	return [
		{
			target,
			targetPresent: false,
			tempPresent: false,
			sameInode: false,
			linkCount: 0,
			contentMatches: true,
			metadataMatches: true,
			laterStagePresent: false,
			publishedPrefixLength: spec.stageIndex,
			parentEntryCount: spec.parentBaseEntries,
		},
		{
			target,
			targetPresent: false,
			tempPresent: true,
			sameInode: false,
			linkCount: 1,
			contentMatches: true,
			metadataMatches: true,
			laterStagePresent: false,
			publishedPrefixLength: spec.stageIndex,
			parentEntryCount: spec.parentBaseEntries + 1,
		},
		{
			target,
			targetPresent: true,
			tempPresent: true,
			sameInode: true,
			linkCount: 2,
			contentMatches: true,
			metadataMatches: true,
			laterStagePresent: false,
			publishedPrefixLength: spec.stageIndex + 1,
			parentEntryCount: spec.parentBaseEntries + 2,
		},
		{
			target,
			targetPresent: true,
			tempPresent: false,
			sameInode: false,
			linkCount: 1,
			contentMatches: true,
			metadataMatches: true,
			laterStagePresent: false,
			publishedPrefixLength: spec.stageIndex + 1,
			parentEntryCount: spec.parentBaseEntries + 1,
		},
	];
}

function mutateCreatePublication(
	state: CreatePublicationState,
	sameInode: boolean,
	linkCount: number,
	contentMatches: boolean,
	metadataMatches: boolean,
	laterStagePresent: boolean,
): CreatePublicationState {
	return {
		target: state.target,
		targetPresent: state.targetPresent,
		tempPresent: state.tempPresent,
		sameInode,
		linkCount,
		contentMatches,
		metadataMatches,
		laterStagePresent,
		publishedPrefixLength: state.publishedPrefixLength,
		parentEntryCount: state.parentEntryCount,
	};
}

interface RetiredWalRow {
	revision: number;
	state: number;
}

function retiredSuffixReachable(rows: readonly RetiredWalRow[], headRevision: number | null): boolean {
	if (rows.length < 1) return false;
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		if (row === undefined) return false;
		if (index > 0) {
			const prior = rows[index - 1];
			if (prior === undefined || row.revision !== prior.revision + 1) return false;
		}
		if (row.revision === 1 && row.state !== 1) return false;
		if (row.revision === 2 && row.state !== 2) return false;
		if (row.revision === 3 && row.state !== 8) return false;
		if (row.revision < 1 || row.revision > 3) return false;
	}
	const terminal = rows[rows.length - 1];
	if (terminal === undefined || terminal.revision !== 3 || terminal.state !== 8) return false;
	if (headRevision === null) return rows.length === 1;
	return headRevision === 3;
}

const CREATE_PUBLICATION_SOURCE_MUTATIONS: readonly SourceMutation[] = [
	{
		functionName: "_linked_temp_for_target",
		anchor: "if target_st.st_nlink == 1:",
		replacement: "if target_st.st_nlink >= 1:",
	},
	{
		functionName: "_linked_temp_for_target",
		anchor: "_validate_file_stat(target_st, uid, device, 2)",
		replacement: "_validate_file_stat(target_st, uid, device, 1)",
	},
	{
		functionName: "_linked_temp_for_target",
		anchor: 'if candidate.startswith(b".tmp."):',
		replacement: 'if not candidate.startswith(b".tmp."):',
	},
	{
		functionName: "_linked_temp_for_target",
		anchor: "if not _valid_temp(candidate):",
		replacement: "if _valid_temp(candidate):",
	},
	{
		functionName: "_linked_temp_for_target",
		anchor: "if candidate_st.st_dev == target_st.st_dev and candidate_st.st_ino == target_st.st_ino:",
		replacement: "if candidate_st.st_dev != target_st.st_dev and candidate_st.st_ino == target_st.st_ino:",
	},
	{
		functionName: "_linked_temp_for_target",
		anchor: "if candidate_st.st_dev == target_st.st_dev and candidate_st.st_ino == target_st.st_ino:",
		replacement: "if candidate_st.st_dev == target_st.st_dev and candidate_st.st_ino != target_st.st_ino:",
	},
	{
		functionName: "_linked_temp_for_target",
		anchor: "_validate_file_stat(candidate_st, uid, device, 2)",
		replacement: "_validate_file_stat(candidate_st, uid, device, 1)",
	},
	{
		functionName: "_linked_temp_for_target",
		anchor: "                if found is not None:\n                    raise Fatal(_E_NLINK)",
		replacement: "                if found is None:\n                    raise Fatal(_E_NLINK)",
	},
	{
		functionName: "_linked_temp_for_target",
		anchor: "    if found is None:\n        raise Fatal(_E_NLINK)",
		replacement: "    if found is not None:\n        raise Fatal(_E_NLINK)",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "if len(entries) != 2 or _IDENTITY not in entries or linked_temp not in entries:",
		replacement: "if len(entries) < 2 or _IDENTITY not in entries or linked_temp not in entries:",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "if temp_st.st_dev != identity_st.st_dev or temp_st.st_ino != identity_st.st_ino:",
		replacement: "if temp_st.st_dev == identity_st.st_dev or temp_st.st_ino != identity_st.st_ino:",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "if temp_st.st_dev != identity_st.st_dev or temp_st.st_ino != identity_st.st_ino:",
		replacement: "if temp_st.st_dev != identity_st.st_dev or temp_st.st_ino == identity_st.st_ino:",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "temp_name_st.st_dev != temp_st.st_dev",
		replacement: "temp_name_st.st_dev == temp_st.st_dev",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "or temp_name_st.st_ino != temp_st.st_ino",
		replacement: "or temp_name_st.st_ino == temp_st.st_ino",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "or identity_name_st.st_dev != identity_st.st_dev",
		replacement: "or identity_name_st.st_dev == identity_st.st_dev",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "or identity_name_st.st_ino != identity_st.st_ino",
		replacement: "or identity_name_st.st_ino == identity_st.st_ino",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "_validate_file_stat(temp_st, uid, device, 2)",
		replacement: "_validate_file_stat(temp_st, uid, device, 1)",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "_validate_file_stat(identity_st, uid, device, 2)",
		replacement: "_validate_file_stat(identity_st, uid, device, 1)",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "_unlink(parent, linked_temp)",
		replacement: "_unlink(parent, _IDENTITY)",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "_prove_published(fds, parent, _IDENTITY, temp_fd, temp_st.st_dev, temp_st.st_ino, genesis, uid, device)",
		replacement:
			"_prove_published(fds, parent, linked_temp, temp_fd, temp_st.st_dev, temp_st.st_ino, genesis, uid, device)",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "_validate_file_stat(retained_identity, uid, device)",
		replacement: "_validate_file_stat(retained_identity, uid, device, 2)",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "_read_bound_fd(identity_fd, genesis)\n        final_identity, final_identity_error",
		replacement: "_read_bound_fd(identity_fd, bytearray())\n        final_identity, final_identity_error",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "_validate_file_stat(final_identity, uid, device)",
		replacement: "_validate_file_stat(final_identity, uid, device, 2)",
	},
	{
		functionName: "_repair_create_identity_link",
		anchor: "if final_temp is not None or final_temp_error != errno.ENOENT:",
		replacement: "if final_temp is None or final_temp_error == errno.ENOENT:",
	},
	{
		functionName: "_prove_published",
		anchor: "_validate_file_stat(retained, uid, device)",
		replacement: "_validate_file_stat(retained, uid, device, 2)",
	},
	{
		functionName: "_prove_published",
		anchor: "_validate_file_stat(final, uid, device)",
		replacement: "_validate_file_stat(final, uid, device, 2)",
	},
	{
		functionName: "_prove_published",
		anchor: "_read_bound_fd(temp_fd, content)",
		replacement: "_read_bound_fd(temp_fd, bytearray())",
	},
	{
		functionName: "_prove_published",
		anchor: "_read_bound_fd(reopened, content)",
		replacement: "_read_bound_fd(reopened, bytearray())",
	},
	{
		functionName: "_prove_published",
		anchor: "_validate_file_stat(final_again, uid, device)",
		replacement: "_validate_file_stat(final_again, uid, device, 2)",
	},
	{
		functionName: "_clean_temps",
		anchor: "elif temp_st.st_nlink == 2:",
		replacement: "elif temp_st.st_nlink >= 2:",
	},
	{
		functionName: "_clean_temps",
		anchor: "_validate_file_stat(temp_st, uid, device, 2)",
		replacement: "_validate_file_stat(temp_st, uid, device, 1)",
	},
	{
		functionName: "_clean_temps",
		anchor: "_validate_file_stat(target_st, uid, device, 2)",
		replacement: "_validate_file_stat(target_st, uid, device, 1)",
	},
	{
		functionName: "_clean_temps",
		anchor: "if not _same(actual_digest, expected_digest):",
		replacement: "if _same(actual_digest, expected_digest):",
	},
	{
		functionName: "_clean_temps",
		anchor: "if len(record_data) < 1 or not _same(actual, head_digest):",
		replacement: "if len(record_data) < 1 or _same(actual, head_digest):",
	},
	{
		functionName: "_clean_temps",
		anchor: "                _unlink(parent, name)\n                changed = True\n            else:",
		replacement: "                _unlink(parent, target)\n                changed = True\n            else:",
	},
	{
		functionName: "_read_matching",
		anchor: "data, error = _read_file(fds, parent, name, uid, device, len(expected), len(expected))",
		replacement: "data, error = _read_file(fds, parent, name, uid, device, len(expected), len(expected), links=2)",
	},
	{
		functionName: "_read_matching",
		anchor: "return _same(data, expected), None",
		replacement: "return True, None",
	},
	{
		functionName: "_validate_create_publication_links",
		anchor: "later_present or len(entries) != 2",
		replacement: "len(entries) != 2",
	},
	{
		functionName: "_validate_create_publication_links",
		anchor: "later_present or len(entries) != 3",
		replacement: "len(entries) != 3",
	},
];

function createPublicationSourceIsExact(source: string): boolean {
	const bodies = new Map<string, string>();
	for (const mutation of CREATE_PUBLICATION_SOURCE_MUTATIONS) {
		if (!bodies.has(mutation.functionName)) {
			bodies.set(mutation.functionName, pythonFunction(source, mutation.functionName).body);
		}
		const body = bodies.get(mutation.functionName);
		if (body === undefined || count(body, mutation.anchor) !== 1) return false;
	}
	const completion = pythonFunction(source, "_complete_create").body;
	const identityRepair = pythonFunction(source, "_repair_create_identity_link").body;
	const publicationLinks = pythonFunction(source, "_validate_create_publication_links").body;
	const cleaner = pythonFunction(source, "_clean_temps").body;
	const proof = pythonFunction(source, "_prove_published").body;
	const readMatching = pythonFunction(source, "_read_matching").body;
	return (
		tokensInOrder(readMatching, [
			"_read_file(fds, parent, name, uid, device, len(expected), len(expected))",
			"return _same(data, expected), None",
		]) &&
		tokensInOrder(identityRepair, [
			"_open_file(fds, parent, linked_temp, uid, device, len(genesis), len(genesis), 2)",
			"_open_file(fds, parent, _IDENTITY, uid, device, len(genesis), len(genesis), 2)",
			"_unlink(parent, linked_temp)",
			"_fsync(parent)",
			"_prove_published(fds, parent, _IDENTITY",
			"_validate_file_stat(retained_identity, uid, device)",
			"_read_bound_fd(identity_fd, genesis)",
			"_validate_file_stat(final_identity, uid, device)",
			"final_temp_error != errno.ENOENT",
		]) &&
		tokensInOrder(proof, [
			"_validate_file_stat(retained, uid, device)",
			"_validate_file_stat(final, uid, device)",
			"_read_bound_fd(temp_fd, content)",
			"_open_file(fds, parent, target, uid, device, len(content), len(content))",
			"_read_bound_fd(reopened, content)",
			"_fdatasync(reopened)",
			"_validate_file_stat(final_again, uid, device)",
		]) &&
		tokensInOrder(publicationLinks, [
			"record_temp = _linked_temp_for_target(parent, entries, record_target",
			"head_temp = _linked_temp_for_target(parent, entries, _HEAD",
			"later_present or len(entries) != 2 or record_target not in entries or record_temp not in entries",
			"later_present or len(entries) != 3 or record_target not in entries or _HEAD not in entries or head_temp not in entries",
		]) &&
		tokensInOrder(cleaner, [
			"elif temp_st.st_nlink == 2:",
			"_validate_file_stat(temp_st, uid, device, 2)",
			"_validate_file_stat(target_st, uid, device, 2)",
			"_unlink(parent, name)",
			"if changed:",
			"_fsync(parent)",
		]) &&
		count(completion, "_repair_create_identity_link(") === 1 &&
		count(completion, "_validate_create_publication_links(") === 2 &&
		count(completion, "match_error is not None or not matched") === 5 &&
		tokensInOrder(completion, [
			"_repair_create_identity_link(fds, lifecycle_fd, lifecycle_entries, genesis, identity_digest",
			'_clean_temps(fds, lifecycle_fd, lifecycle_entries, uid, device, b"", (_IDENTITY,))',
			"_validate_create_publication_links(ledger_fd, ledger_entries, ledger_record, generations_present",
			'_clean_temps(fds, ledger_fd, ledger_entries, uid, device, b".rec", (_HEAD,))',
			"_validate_create_publication_links(wal_fd, wal_entries, wal_record, False",
			'_clean_temps(fds, wal_fd, wal_entries, uid, device, b".wal", (_HEAD,))',
			"stages = (",
			"identity_present,",
			"ledger_present,",
			"ledger_record_present,",
			"ledger_head_present,",
			"generations_present,",
			"generation_present,",
			"wal_present,",
			"wal_record_present,",
			"wal_head_present,",
			"if not identity_present:",
			"_publish_record(fds, lifecycle_fd, _IDENTITY",
			"if not ledger_record_present:",
			"_publish_record(fds, ledger_fd, ledger_record",
			"if not ledger_head_present:",
			"_publish_head(fds, ledger_fd, _HEAD",
			"if not wal_record_present:",
			"_publish_record(fds, wal_fd, wal_record",
			"if not wal_head_present:",
			"_publish_head(fds, wal_fd, _HEAD",
		])
	);
}

function createRecoveryIsExact(source: string): boolean {
	const command = pythonFunction(source, "_cmd_create").body;
	const completion = pythonFunction(source, "_complete_create").body;
	const cleaner = pythonFunction(source, "_clean_temps").body;
	const identityRepair = pythonFunction(source, "_repair_create_identity_link").body;
	const publicationLinks = pythonFunction(source, "_validate_create_publication_links").body;
	const published = branchBody(command, "if _HEAD in existing_entries:");
	const emptyIdentity = branchBody(completion, "if not identity_present:");
	const emptyLedger = branchBody(completion, "if not ledger_present:");
	const emptyWalRecord = branchBody(completion, "if not wal_record_present:");
	return (
		createPublicationSourceIsExact(source) &&
		tokensInOrder(identityRepair, [
			"linked_temp = _linked_temp_for_target(parent, entries, _IDENTITY",
			"len(entries) != 2",
			"_open_file(fds, parent, linked_temp",
			"_open_file(fds, parent, _IDENTITY",
			"temp_st.st_dev != identity_st.st_dev or temp_st.st_ino != identity_st.st_ino",
			"_read_bound_fd(temp_fd, genesis)",
			"_read_bound_fd(identity_fd, genesis)",
			"request_digest = _digest(genesis)",
			"not _same(request_digest, identity_digest)",
			"_unlink(parent, linked_temp)",
			"_fsync(parent)",
			"_prove_published(fds, parent, _IDENTITY, temp_fd",
			"_validate_file_stat(retained_identity, uid, device)",
			"final_temp_error != errno.ENOENT",
			"fds.close_after(mark)",
			"if fds.uncertain:",
		]) &&
		count(identityRepair, "len(genesis), len(genesis), 2") === 2 &&
		tokensInOrder(publicationLinks, [
			"record_temp = _linked_temp_for_target(parent, entries, record_target",
			"head_temp = _linked_temp_for_target(parent, entries, _HEAD",
			"if record_temp is not None:",
			"later_present or len(entries) != 2",
			"if head_temp is not None:",
			"later_present or len(entries) != 3",
		]) &&
		cleaner.includes("elif temp_st.st_nlink == 2:") &&
		cleaner.includes("parsed_target = _parse_record_name(target, record_suffix)") &&
		cleaner.includes("if not _same(actual_digest, expected_digest):") &&
		cleaner.includes('target == _HEAD and record_suffix in (b".rec", b".wal")') &&
		tokensInOrder(cleaner, ["_unlink(parent, name)", "if changed:", "_fsync(parent)"]) &&
		published.includes("_published_create_has_temp(") &&
		published.includes("_scan_lifecycle(") &&
		published.includes("_close_scan(fds, scan)") &&
		published.includes("fds.require_certain()") &&
		published.includes("fds.end_recovery(recovery_expected)") &&
		published.includes("return None, _E_EXISTS") &&
		emptyIdentity.includes("_publish_record(fds, lifecycle_fd, _IDENTITY") &&
		!emptyIdentity.includes("raise Fatal") &&
		emptyLedger.includes("_make_dir(fds, lifecycle_fd, _LEDGER") &&
		!emptyLedger.includes("raise Fatal(_E_STATE)") &&
		emptyWalRecord.includes("_publish_record(fds, wal_fd, wal_record, allocated") &&
		!emptyWalRecord.includes("raise Fatal(_E_STATE)") &&
		branchBody(completion, "elif missing:").includes("raise Fatal(_E_STATE)") &&
		count(completion, "match_error is not None or not matched") === 5 &&
		count(completion, "_repair_create_identity_link(") === 1 &&
		count(completion, "_validate_create_publication_links(") === 2 &&
		count(completion, '_clean_temps(fds, ledger_fd, ledger_entries, uid, device, b".rec", (_HEAD,))') === 1 &&
		count(completion, '_clean_temps(fds, wal_fd, wal_entries, uid, device, b".wal", (_HEAD,))') === 1 &&
		tokensInOrder(command, [
			"if lifecycle_fd is not None:",
			"if _HEAD in existing_entries:",
			"return None, _E_EXISTS",
			"_validate_allocated(allocated, lifecycle, generation, identity_digest)",
			"_complete_create(",
			"if error != errno.ENOENT:",
			"root_entries = _list(root_fd)",
			"if lifecycle_count >= 1024:",
			"lifecycle_fd, created = _make_dir(",
		]) &&
		tokensInOrder(completion, [
			"_repair_create_identity_link(fds, lifecycle_fd, lifecycle_entries, genesis, identity_digest",
			'_clean_temps(fds, lifecycle_fd, lifecycle_entries, uid, device, b"", (_IDENTITY,))',
			"_validate_create_publication_links(ledger_fd, ledger_entries, ledger_record, generations_present",
			'_clean_temps(fds, ledger_fd, ledger_entries, uid, device, b".rec", (_HEAD,))',
			"_validate_create_publication_links(wal_fd, wal_entries, wal_record, False",
			'_clean_temps(fds, wal_fd, wal_entries, uid, device, b".wal", (_HEAD,))',
			"stages = (",
			"elif missing:",
			"if not identity_present:",
			"if not ledger_present:",
			"if not ledger_record_present:",
			"if not ledger_head_present:",
			"if not generations_present:",
			"if not generation_present:",
			"if not wal_present:",
			"if not wal_record_present:",
			"if not wal_head_present:",
			"_publish_head(fds, lifecycle_fd, _HEAD, session_head",
		])
	);
}

function retiredRevisionChecks(source: string): boolean {
	const removeSuffix = pythonFunction(source, "_remove_generation_suffix").body;
	const peek = pythonFunction(source, "_peek_generation_state").body;
	const scanWal = pythonFunction(source, "_scan_wal").body;
	const recovery = pythonFunction(source, "_recover_generation_stages").body;
	const purge = pythonFunction(source, "_recover_purge_suffix").body;
	return (
		tokensInOrder(removeSuffix, [
			"terminal_state = _validate_wal_suffix(",
			"terminal_revision != 3",
			"rows[-1][0] != 3",
			"head_revision != rows[-1][0]",
			"_unlink(wal_fd, rows[-1][1])",
		]) &&
		tokensInOrder(peek, [
			"elif state_value == _W_RETIRED_ABSENT:",
			"if found_revision != 3:",
			"raise Fatal(_E_STATE)",
			"return state_value",
		]) &&
		scanWal.includes("rows[0][0] == 3") &&
		scanWal.includes("(_W_RETIRED_ABSENT, 3)") &&
		recovery.includes("current_state == _W_RETIRED_ABSENT and current_last_revision != 3") &&
		purge.includes("wal_rows[-1][0] != _MAX_WAL_RECORDS")
	);
}

const RECOVERY_PHASES = [
	"_clean_temps(fds, root_fd",
	"_rollback_unpublished(",
	"_repair_lifecycle_head_link(",
	"_recover_purge_suffix(",
	"_recover_generation_stages(",
	"_close_scan(fds, scan)",
	"fds.close(lifecycle_fd)",
	"_fsync(root_fd)",
];

function recoveryPhaseChecks(body: string): boolean {
	let searchFrom = 0;
	for (const phase of RECOVERY_PHASES) {
		const phaseIndex = body.indexOf(phase, searchFrom);
		if (phaseIndex < 0) return false;
		const certaintyIndex = body.indexOf("fds.require_certain()", phaseIndex + phase.length);
		if (certaintyIndex < 0) return false;
		const nextPhase = RECOVERY_PHASES[RECOVERY_PHASES.indexOf(phase) + 1];
		if (nextPhase !== undefined) {
			const nextIndex = body.indexOf(nextPhase, phaseIndex + phase.length);
			if (nextIndex >= 0 && certaintyIndex > nextIndex) return false;
		}
		searchFrom = phaseIndex + phase.length;
	}
	return true;
}

function removePhaseCertainty(body: string, phase: number): string {
	const marker = RECOVERY_PHASES[phase];
	if (marker === undefined) return body;
	const start = body.indexOf(marker);
	if (start < 0) return body;
	const nextMarker = RECOVERY_PHASES[phase + 1];
	const foundEnd = nextMarker === undefined ? body.length : body.indexOf(nextMarker, start + marker.length);
	const end = foundEnd < 0 ? body.length : foundEnd;
	const phaseBody = body.slice(start, end).split("fds.require_certain()").join("");
	return body.slice(0, start) + phaseBody + body.slice(end);
}

interface RecoveryOutcome {
	mutationsAfterUncertainty: number;
	responded: boolean;
}

function recoveryFaultModel(faultPhase: number): RecoveryOutcome {
	let uncertain = false;
	let mutationsAfterUncertainty = 0;
	for (let phase = 0; phase < RECOVERY_PHASES.length; phase += 1) {
		if (phase === faultPhase) uncertain = true;
		if (uncertain) continue;
		if (phase + 1 < RECOVERY_PHASES.length) mutationsAfterUncertainty += 0;
	}
	return { mutationsAfterUncertainty, responded: !uncertain };
}

function recoveryCertaintyIsExact(source: string): boolean {
	const fds = pythonClass(source, "Fds");
	const recover = pythonFunction(source, "_recover_root").body;
	const main = pythonFunction(source, "main").body;
	const closeForRecovery = branchBody(fds, "def close_for_recovery(self, fd):");
	const rollbackEmpty = pythonFunction(source, "_rollback_empty_generation").body;
	const removeSuffix = pythonFunction(source, "_remove_generation_suffix").body;
	const rollbackUnpublished = pythonFunction(source, "_rollback_unpublished").body;
	const purge = pythonFunction(source, "_recover_purge_suffix").body;
	const publishedCreate = pythonFunction(source, "_published_create_has_temp").body;
	const completeCreate = pythonFunction(source, "_complete_create").body;
	return (
		fds.includes('__slots__ = ("items", "uncertain", "recovering")') &&
		tokensInOrder(closeForRecovery, ["self.close(fd)", "self.require_certain()"]) &&
		rollbackEmpty.includes("close_for_recovery") &&
		removeSuffix.includes("close_for_recovery") &&
		rollbackUnpublished.includes("close_for_recovery") &&
		purge.includes("close_for_recovery") &&
		publishedCreate.includes("close_for_recovery") &&
		completeCreate.includes("close_for_recovery") &&
		fds.includes("def close_all(self):\n        self.recovering = False") &&
		tokensInOrder(recover, [
			"fds.begin_recovery()",
			"_root_check(root_fd",
			"fds.require_certain()",
			"_fsync(root_fd)",
			"fds.end_recovery([root_fd, lock_fd])",
		]) &&
		recoveryPhaseChecks(recover) &&
		tokensInOrder(main, [
			"_recover_root(",
			"_root_check(root_fd",
			"if fds.uncertain or fds.recovering or fds.items != [root_fd, lock_fd]:",
			"opened = True",
			"_ok_payload(_OPEN)",
		])
	);
}

describe("hosted session Store POSIX helper V7 static structure", () => {
	test("REMOVE rejects raced absence after its positive observation", async () => {
		const source = await readFile(HELPER, "utf8");
		const removeSuffix = pythonFunction(source, "_remove_generation_suffix");
		const command = pythonFunction(source, "_cmd_remove");
		expect(removeSuffix.startLine).toBeGreaterThan(0);
		expect(removeSuffix.header).toContain("positive_observation");
		expect(
			tokensInOrder(removeSuffix.body, [
				"if error == errno.ENOENT and not positive_observation:",
				"return",
				"raise Fatal(_E_UNCERTAIN)",
			]),
		).toBe(true);
		expect(command.body).toContain(
			"fds, generations_fd, retired_name, lifecycle, uid, device, True, identity_digest, current_entry[4][2]",
		);
	});

	test("REMOVE accepts only the mechanically reachable revision-three suffix", async () => {
		const source = await readFile(HELPER, "utf8");
		expect(
			retiredSuffixReachable(
				[
					{ revision: 1, state: 1 },
					{ revision: 2, state: 2 },
					{ revision: 3, state: 8 },
				],
				3,
			),
		).toBe(true);
		expect(
			retiredSuffixReachable(
				[
					{ revision: 2, state: 2 },
					{ revision: 3, state: 8 },
				],
				3,
			),
		).toBe(true);
		expect(retiredSuffixReachable([{ revision: 3, state: 8 }], null)).toBe(true);
		expect(retiredSuffixReachable([{ revision: 6, state: 8 }], 6)).toBe(false);
		expect(retiredSuffixReachable([{ revision: 6, state: 8 }], null)).toBe(false);
		expect(retiredRevisionChecks(source)).toBe(true);
		const terminalRevisionMutant = mutatePythonFunction(
			source,
			"_remove_generation_suffix",
			"terminal_revision != 3",
			"terminal_revision != 6",
		);
		expect(terminalRevisionMutant.length).toBeGreaterThan(0);
		expect(retiredRevisionChecks(terminalRevisionMutant)).toBe(false);
		const terminalRowMutant = mutatePythonFunction(
			source,
			"_remove_generation_suffix",
			"rows[-1][0] != 3",
			"rows[-1][0] != 6",
		);
		expect(terminalRowMutant.length).toBeGreaterThan(0);
		expect(retiredRevisionChecks(terminalRowMutant)).toBe(false);
		const peekMutant = mutatePythonFunction(
			source,
			"_peek_generation_state",
			"if found_revision != 3:",
			"if found_revision != 6:",
		);
		expect(peekMutant.length).toBeGreaterThan(0);
		expect(retiredRevisionChecks(peekMutant)).toBe(false);
		const scanMutant = mutatePythonFunction(source, "_scan_wal", "rows[0][0] == 3", "rows[0][0] == 6");
		expect(scanMutant.length).toBeGreaterThan(0);
		expect(retiredRevisionChecks(scanMutant)).toBe(false);
	});

	test("REMOVE suffix validation precedes every teardown mutation", async () => {
		const source = await readFile(HELPER, "utf8");
		const removeSuffix = pythonFunction(source, "_remove_generation_suffix").body;
		expect(
			tokensInOrder(removeSuffix, [
				"rows, unused_total = _scan_suffix_records(",
				"terminal_state = _validate_wal_suffix(",
				"terminal_revision != 3",
				"head_revision != rows[-1][0]",
				"if head_temp is not None:",
				"_unlink(wal_fd, head_temp)",
				"while index + 1 < len(rows):",
				"_unlink(wal_fd, _HEAD)",
				"_unlink(wal_fd, rows[-1][1])",
				"_rmdir(generation_fd, _WAL)",
				"_rmdir(generations_fd, generation_name)",
			]),
		).toBe(true);
	});

	test("PURGE table and recovery reject every independent source mutant", async () => {
		const source = await readFile(HELPER, "utf8");
		const admission = pythonFunction(source, "_purge_stage_pair_allowed").body;
		const command = pythonFunction(source, "_cmd_purge").body;
		const recovery = pythonFunction(source, "_recover_purge_suffix").body;
		expect(purgeStageCountRows(admission).length).toBe(10);
		expect(exactPurgeAdmission(admission)).toBe(true);
		expect(purgeCommandOperationOrder(command).length).toBe(14);
		expect(purgeCommandMatchesModel(command)).toBe(true);
		expect(purgeRecoveryClassifierIsExact(source)).toBe(true);

		for (const sourceOperation of PURGE_SOURCE_OPERATIONS) {
			expect(count(command, sourceOperation.marker)).toBe(1);
			const mutant = replaceUnique(command, sourceOperation.marker, "pass");
			expect(mutant.length).toBeGreaterThan(0);
			expect(purgeCommandMatchesModel(mutant)).toBe(false);
		}

		for (const mutation of PURGE_RECOVERY_MUTATIONS) {
			const mutant = mutatePythonFunction(source, mutation.functionName, mutation.anchor, mutation.replacement);
			expect(mutant.length).toBeGreaterThan(0);
			expect(purgeRecoveryClassifierIsExact(mutant)).toBe(false);
		}

		for (const mutation of PURGE_TABLE_ROW_MUTATIONS) {
			const mutant = mutatePythonFunction(source, mutation.functionName, mutation.anchor, mutation.replacement);
			expect(mutant.length).toBeGreaterThan(0);
			const mutantAdmission = pythonFunction(mutant, "_purge_stage_pair_allowed").body;
			expect(exactPurgeAdmission(mutantAdmission)).toBe(false);
		}

		expect(
			tokensInOrder(recovery, [
				"if not _same(identity_digest, head_identity):",
				"ledger_number != ledger_rows[-1][0]",
				"_validate_wal_suffix(wal_rows, lifecycle, current_generation, identity_digest)",
				"wal_revision != wal_rows[-1][0]",
				"wal_rows[-1][0] != _MAX_WAL_RECORDS",
				"_purge_stage_pair_allowed(generation_stage, ledger_stage, len(wal_rows), len(ledger_rows))",
				"_unlink(wal_fd, wal_rows[index][1])",
			]),
		).toBe(true);
	});

	test("PURGE crash recovery remains forward-only and keeps revision seven", async () => {
		const source = await readFile(HELPER, "utf8");
		const recovery = pythonFunction(source, "_recover_purge_suffix").body;
		expect(
			tokensInOrder(recovery, [
				"_unlink(wal_fd, wal_rows[index][1])",
				"_unlink(ledger_fd, ledger_rows[index][1])",
				"_unlink(wal_fd, _HEAD)",
				"_unlink(wal_fd, wal_rows[-1][1])",
				"_rmdir(generation_fd, _WAL)",
				"_rmdir(generations_fd, current_name)",
				"_rmdir(lifecycle_fd, _GENERATIONS)",
				"_unlink(ledger_fd, _HEAD)",
				"_unlink(ledger_fd, ledger_rows[-1][1])",
				"_rmdir(lifecycle_fd, _LEDGER)",
				"_unlink(lifecycle_fd, _HEAD)",
				"_unlink(lifecycle_fd, _IDENTITY)",
				"_rmdir(root_fd, lifecycle_name)",
				"_probe_absent(root_fd, lifecycle_name)",
			]),
		).toBe(true);
		expect(recovery).toContain("wal_rows[-1][0] != _MAX_WAL_RECORDS");
	});

	test("CREATE publication model is source-bound for every target and reachable prefix", async () => {
		const source = await readFile(HELPER, "utf8");
		const empty = [false, false, false, false, false, false, false, false, false];
		const partial = [true, true, true, false, false, false, false, false, false];
		const complete = [true, true, true, true, true, true, true, true, true];
		expect(createDisposition(true, complete, true, false, false)).toBe("exists");
		expect(createDisposition(false, empty, false, true, false)).toBe("complete");
		expect(createDisposition(false, partial, false, true, false)).toBe("complete");
		expect(createDisposition(false, partial, false, false, false)).toBe("fatal");
		expect(createDisposition(false, partial, false, true, true)).toBe("fatal");
		expect(createDisposition(true, partial, false, true, false)).toBe("fatal");

		const expectedPrefixes = [
			"000000000",
			"100000000",
			"110000000",
			"111000000",
			"111100000",
			"111110000",
			"111111000",
			"111111100",
			"111111110",
			"111111111",
		];
		for (let mask = 0; mask < 512; mask += 1) {
			const stages: boolean[] = [];
			let key = "";
			for (let stage = 0; stage < 9; stage += 1) {
				const present = (mask & (1 << stage)) !== 0;
				stages.push(present);
				key += present ? "1" : "0";
			}
			expect(createPrefixAllowed(stages)).toBe(expectedPrefixes.includes(key));
		}

		expect(CREATE_PUBLICATION_TARGETS.length).toBe(5);
		expect(createPublicationSourceIsExact(source)).toBe(true);
		for (const targetSpec of CREATE_PUBLICATION_TARGETS) {
			const fixtures = createPublicationFixtures(targetSpec.target);
			expect(fixtures.length).toBe(4);
			for (const fixture of fixtures) {
				expect(createPublicationDisposition(source, fixture)).toBe("complete");
			}
			const linked = fixtures[2];
			if (linked !== undefined) {
				expect(
					createPublicationDisposition(source, mutateCreatePublication(linked, false, 2, true, true, false)),
				).toBe("fatal");
				expect(
					createPublicationDisposition(source, mutateCreatePublication(linked, true, 3, true, true, false)),
				).toBe("fatal");
				expect(
					createPublicationDisposition(source, mutateCreatePublication(linked, true, 2, false, true, false)),
				).toBe("fatal");
				expect(
					createPublicationDisposition(source, mutateCreatePublication(linked, true, 2, true, false, false)),
				).toBe("fatal");
				expect(
					createPublicationDisposition(source, mutateCreatePublication(linked, true, 2, true, true, true)),
				).toBe("fatal");
			}
		}

		for (const mutation of CREATE_PUBLICATION_SOURCE_MUTATIONS) {
			const mutant = mutatePythonFunction(source, mutation.functionName, mutation.anchor, mutation.replacement);
			expect(mutant.length).toBeGreaterThan(0);
			expect(createPublicationSourceIsExact(mutant)).toBe(false);
			for (const targetSpec of CREATE_PUBLICATION_TARGETS) {
				const linked = createPublicationFixtures(targetSpec.target)[2];
				if (linked !== undefined) {
					expect(createPublicationDisposition(mutant, linked)).toBe("fatal");
				}
			}
		}

		expect(createRecoveryIsExact(source)).toBe(true);
		const publishedBranchMutant = mutatePythonFunction(
			source,
			"_cmd_create",
			"if _HEAD in existing_entries:",
			"if lifecycle_fd is not None:",
		);
		expect(publishedBranchMutant.length).toBeGreaterThan(0);
		expect(createRecoveryIsExact(publishedBranchMutant)).toBe(false);
		const emptyIdentityMutant = mutatePythonFunction(
			source,
			"_complete_create",
			"if not identity_present:\n            _publish_record(fds, lifecycle_fd, _IDENTITY",
			"if not identity_present:\n            raise Fatal(_E_STATE)\n            _publish_record(fds, lifecycle_fd, _IDENTITY",
		);
		expect(emptyIdentityMutant.length).toBeGreaterThan(0);
		expect(createRecoveryIsExact(emptyIdentityMutant)).toBe(false);
		const emptyWalMutant = mutatePythonFunction(
			source,
			"_complete_create",
			"if not wal_record_present:\n            _publish_record(fds, wal_fd, wal_record, allocated",
			"if not wal_record_present:\n            raise Fatal(_E_STATE)\n            _publish_record(fds, wal_fd, wal_record, allocated",
		);
		expect(emptyWalMutant.length).toBeGreaterThan(0);
		expect(createRecoveryIsExact(emptyWalMutant)).toBe(false);
		const prefixMutant = mutatePythonFunction(
			source,
			"_complete_create",
			"elif missing:\n                raise Fatal(_E_STATE)",
			"elif missing:\n                missing = False",
		);
		expect(prefixMutant.length).toBeGreaterThan(0);
		expect(createRecoveryIsExact(prefixMutant)).toBe(false);
	});

	test("CREATE preserves published-before-capacity and partial-before-capacity order", async () => {
		const source = await readFile(HELPER, "utf8");
		const command = pythonFunction(source, "_cmd_create").body;
		expect(
			tokensInOrder(command, [
				"if _HEAD in existing_entries:",
				"_scan_lifecycle(",
				"return None, _E_EXISTS",
				"_validate_allocated(allocated, lifecycle, generation, identity_digest)",
				"_complete_create(",
				"if error != errno.ENOENT:",
				"root_entries = _list(root_fd)",
				"if lifecycle_count >= 1024:",
			]),
		).toBe(true);
		expect(command).toContain("if root_entry == lifecycle_name:");
		expect(command).toContain("if not created:");
	});

	test("OPEN close uncertainty fail-stops every recovery phase", async () => {
		const source = await readFile(HELPER, "utf8");
		expect(recoveryCertaintyIsExact(source)).toBe(true);
		for (let phase = 0; phase < RECOVERY_PHASES.length; phase += 1) {
			const outcome = recoveryFaultModel(phase);
			expect(outcome.mutationsAfterUncertainty).toBe(0);
			expect(outcome.responded).toBe(false);
			const recoverBody = pythonFunction(source, "_recover_root").body;
			const damagedBody = removePhaseCertainty(recoverBody, phase);
			const damagedSource = replaceUnique(source, recoverBody, damagedBody);
			expect(damagedSource.length).toBeGreaterThan(0);
			expect(recoveryCertaintyIsExact(damagedSource)).toBe(false);
		}
	});

	test("OPEN rejects close-guard and descriptor-inventory mutants", async () => {
		const source = await readFile(HELPER, "utf8");
		const beginMutant = mutatePythonFunction(
			source,
			"_recover_root",
			"fds.begin_recovery()",
			"fds.require_certain()",
		);
		expect(beginMutant.length).toBeGreaterThan(0);
		expect(recoveryCertaintyIsExact(beginMutant)).toBe(false);
		const closeMutant = replaceUnique(
			source,
			"def close_for_recovery(self, fd):\n        self.close(fd)\n        self.require_certain()",
			"def close_for_recovery(self, fd):\n        self.close(fd)",
		);
		expect(closeMutant.length).toBeGreaterThan(0);
		expect(recoveryCertaintyIsExact(closeMutant)).toBe(false);
		const endMutant = mutatePythonFunction(
			source,
			"_recover_root",
			"fds.end_recovery([root_fd, lock_fd])",
			"fds.recovering = False",
		);
		expect(endMutant.length).toBeGreaterThan(0);
		expect(recoveryCertaintyIsExact(endMutant)).toBe(false);
		const uncertaintyOnlyMutant = mutatePythonFunction(
			source,
			"main",
			"if fds.uncertain or fds.recovering or fds.items != [root_fd, lock_fd]:",
			"if fds.uncertain:",
		);
		expect(uncertaintyOnlyMutant.length).toBeGreaterThan(0);
		expect(recoveryCertaintyIsExact(uncertaintyOnlyMutant)).toBe(false);
		const countOnlyMutant = mutatePythonFunction(
			source,
			"main",
			"if fds.uncertain or fds.recovering or fds.items != [root_fd, lock_fd]:",
			"if len(fds.items) < 2:",
		);
		expect(countOnlyMutant.length).toBeGreaterThan(0);
		expect(recoveryCertaintyIsExact(countOnlyMutant)).toBe(false);
		const lateGuardMutant = mutatePythonFunction(
			source,
			"main",
			"if fds.uncertain or fds.recovering or fds.items != [root_fd, lock_fd]:\n                        raise Fatal(_E_UNCERTAIN)\n                    opened = True",
			"opened = True\n                    if fds.uncertain or fds.recovering or fds.items != [root_fd, lock_fd]:\n                        raise Fatal(_E_UNCERTAIN)",
		);
		expect(lateGuardMutant.length).toBeGreaterThan(0);
		expect(recoveryCertaintyIsExact(lateGuardMutant)).toBe(false);
	});

	test("OPEN never synthesizes a missing current WAL head", async () => {
		const source = await readFile(HELPER, "utf8");
		const scanWal = pythonFunction(source, "_scan_wal");
		const recovery = pythonFunction(source, "_recover_generation_stages");
		expect(scanWal.header).toContain("allow_missing_head_repair=True");
		expect(scanWal.body).toContain("if repair and allow_missing_head_repair and len(rows) == 1");
		expect(recovery.body).toContain("fds, generations_fd, current_name, lifecycle, uid, device, True, False, False");
	});

	test("owned SESSION buffers are zeroed across close, root-check, and write failures", async () => {
		const source = await readFile(HELPER, "utf8");
		const readFileBody = pythonFunction(source, "_read_file").body;
		const inventory = pythonFunction(source, "_cmd_inventory").body;
		const main = pythonFunction(source, "main").body;
		expect(
			tokensInOrder(readFileBody, [
				"complete = False",
				"if count <= 0:",
				"raise Fatal(_E_UNCERTAIN)",
				"if not complete and result is not None:",
				"_zero(result)",
			]),
		).toBe(true);
		const guardedInventory = inventoryResponseGuard(inventory);
		expect(
			tokensInOrder(guardedInventory, [
				"_close_scan(fds, scan)",
				"fds.close(lifecycle_fd)",
				"if fds.uncertain:",
				"_root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)",
				"_write_frame(output_fd, _SESSION, session_response)",
			]),
		).toBe(true);
		const inventoryMutant = replaceUnique(inventory, "_zero(session_response)", "pass");
		expect(inventoryMutant.length).toBeGreaterThan(0);
		expect(inventoryResponseGuard(inventoryMutant)).toBe("");
		expect(
			tokensInOrder(main, [
				"kind, value = _dispatch_v4(",
				"_root_check(root_fd, root_device, root_inode, uid, lock_fd, lock_device, lock_inode)",
				'if kind in ("ok", "session") and value is not None:',
				"_zero(value)",
				"_zero(payload)",
			]),
		).toBe(true);
	});

	test("root and lock authority remain bound around recovery", async () => {
		const source = await readFile(HELPER, "utf8");
		const bindLock = pythonFunction(source, "_bind_lock").body;
		const recoverRoot = pythonFunction(source, "_recover_root").body;
		expect(
			tokensInOrder(bindLock, [
				"fcntl.flock(root_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
				"fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
			]),
		).toBe(true);
		expect(
			count(recoverRoot, "_root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)"),
		).toBeGreaterThanOrEqual(10);
		expect(recoveryPhaseChecks(recoverRoot)).toBe(true);
	});

	test("V5 startup mode, decoder, and response paths stay exact", async () => {
		const source = await readFile(HELPER, "utf8");
		for (const exact of [
			"_V5_HELLO = 0xF0",
			"_V5_READY = 0x84",
			"_WS_BEGIN = 0x0A",
			"_WS_INVENTORY = 0x17",
			"_MODE_UNSELECTED = 0",
			"_MODE_V4_COMPAT = 1",
			"_MODE_V5_READY = 2",
			"_MODE_V5_BLOCKED = 3",
			"_V5_OPCODES = frozenset((_V5_HELLO, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17))",
		])
			expect(source).toContain(exact);

		const hello = pythonFunction(source, "_v5_handle_hello").body;
		expect(
			tokensInOrder(hello, [
				'if len(payload) != 8 or payload != b"PISTOV05":',
				'return (_MODE_UNSELECTED, "error", _E_PROTOCOL)',
				"if _is_empty_root(root_fd):",
				'return (_MODE_V5_READY, "v5_ready", None)',
				'return (_MODE_V5_BLOCKED, "error", _E_STATE)',
			]),
		).toBe(true);

		const decoder = pythonFunction(source, "_v5_validate_request").body;
		for (const exact of [
			"if len(payload) != 172:",
			"if len(payload) < 169:",
			"if len(payload) == 169:",
			"if len(payload) > 1048576:",
			"if len(payload) != 168:",
			"if len(payload) != 128:",
			"if len(payload) != 173:",
			"raise Fatal(_E_PROTOCOL)",
			"return _E_INPUT",
			"return _E_BOUNDS",
		])
			expect(decoder).toContain(exact);
		expect(
			tokensInOrder(decoder, [
				"data_view = memoryview(payload)[169:]",
				"computed = _digest(data_view)",
				"data_view.release()",
				"if not _same_at(payload, 137, computed):",
				"_zero(computed)",
			]),
		).toBe(true);
		expect(decoder).toContain(`if _range_zero(payload, 96, 128):
            raise Fatal(_E_PROTOCOL)`);
		expect(decoder).toContain(`if opcode == _WS_INVENTORY:
        if len(payload) != 0:
            raise Fatal(_E_PROTOCOL)`);

		const dispatch = pythonFunction(source, "_dispatch_v5").body;
		expect(
			tokensInOrder(dispatch, [
				"if opcode == _V5_HELLO:",
				'return (v5_mode, "error", _E_PROTOCOL)',
				"err = _v5_validate_request(opcode, payload)",
				"if opcode == _WS_INVENTORY:",
				'return (v5_mode, "done", None)',
				"if opcode == _WS_BEGIN:",
				'return (v5_mode, "error", _E_BUSY)',
				'return (v5_mode, "error", _E_ABSENT)',
			]),
		).toBe(true);

		const main = pythonFunction(source, "main").body;
		expect(
			tokensInOrder(main, [
				"command_mark = fds.mark()",
				"if v5_mode == _MODE_UNSELECTED:",
				"next_mode, kind, value = _v5_handle_hello(root_fd, payload)",
				"kind, value = _dispatch_v4(",
				"elif v5_mode == _MODE_V4_COMPAT:",
				"elif v5_mode == _MODE_V5_BLOCKED:",
				"elif v5_mode == _MODE_V5_READY:",
				"next_mode, kind, value = _dispatch_v5(current_opcode, payload, v5_mode)",
				"fds.close_after(command_mark)",
				"if fds.mark() != command_mark or fds.uncertain:",
				"_root_check(root_fd, root_device, root_inode, uid, lock_fd, lock_device, lock_inode)",
				"v5_mode = next_mode",
				'elif kind == "v5_ready":',
				"response = bytearray(9)",
				"response[0] = _V5_HELLO",
				'response[1:9] = b"PISTOV05"',
				"_write_frame(1, _V5_READY, response)",
				'elif kind == "done":',
				"_write_frame(1, _DONE, response)",
				"_zero(payload)",
			]),
		).toBe(true);
		expect(main).toContain(`if current_opcode not in _V5_OPCODES:
                            raise Fatal(_E_PROTOCOL)`);
		expect(main).toContain(`if current_opcode != _V5_HELLO:
                            raise Fatal(_E_PROTOCOL)`);
	});

	test("static source keeps the hostile-input boundary and forbidden syntax closed", async () => {
		const source = await readFile(HELPER, "utf8");
		expect(/(^|[^.A-Za-z0-9_])open\s*\(/m.test(source)).toBe(false);
		expect(
			/\b(os\.environ|os\.getenv|sys\.argv|traceback|subprocess|tempfile|socket|eval|exec|input|print)\b/.test(
				source,
			),
		).toBe(false);
	});
});
