import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HELPER = fileURLToPath(
	new URL("../src/modes/daemon/sandbox/hosted-session-store-posix-helper.py", import.meta.url),
);

const execFileAsync = promisify(execFile);

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
		anchor: "elif generation_entries == [_WAL] or _WORKSPACE_EVIDENCE in generation_entries:",
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
		"elif generation_entries == [_WAL] or _WORKSPACE_EVIDENCE in generation_entries:",
		"wal_head_present = _HEAD in wal_entries",
		"if wal_head_present:",
		'generation_stage = "full-head" if wal_rows[0][0] == 1 else "suffix-head"',
		"elif len(wal_rows) == 1:",
		'generation_stage = "terminal-record"',
		"elif len(wal_rows) == 0:",
		'generation_stage = "empty-wal"',
		'generation_stage = "absent"',
		"if v5_evidence:",
		"raise Fatal(_E_STATE)",
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
				"recover_v5_evidence=True",
				"_root_check(root_fd, root_device, root_inode, uid, lock_fd, lock_device, lock_inode)",
				"if fds.uncertain or fds.recovering or fds.items != [root_fd, lock_fd]:",
				"raise Fatal(_E_UNCERTAIN)",
				'return (_MODE_V5_READY, "v5_ready", None)',
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
				"return _cmd_ws_begin(",
				'return (v5_mode, "error", _E_ABSENT)',
			]),
		).toBe(true);

		const main = pythonFunction(source, "main").body;
		expect(
			tokensInOrder(main, [
				"command_mark = fds.mark()",
				"if v5_mode == _MODE_UNSELECTED:",
				"next_mode, kind, value = _v5_handle_hello(fds, root_fd, uid, root_device, root_inode, lock_fd, lock_device, lock_inode, payload)",
				"kind, value = _dispatch_v4(",
				"elif v5_mode == _MODE_V4_COMPAT:",
				"elif v5_mode == _MODE_V5_BLOCKED:",
				"elif v5_mode == _MODE_V5_READY:",
				"next_mode, kind, value = _dispatch_v5(",
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

	test("V5 B00-B13 recovery stays source-bound and executes every byte prefix", async () => {
		const source = await readFile(HELPER, "utf8");
		const recovery = pythonFunction(source, "_v5_recover_input_begin_prefix").body;
		for (const exact of [
			'_WORKSPACE_EVIDENCE = b"workspace-evidence"',
			"def _v5_recover_input_begin_prefix(",
			"def _v5_recover_lifecycle_evidence(",
			"recover_v5_evidence=True",
			"elif v5_tree_present:",
			"next_mode = _MODE_V5_BLOCKED",
		])
			expect(source).toContain(exact);
		expect(
			tokensInOrder(recovery, [
				"_v5_input_manifest_prefix(",
				"_unlink(evidence_fd, manifest_name)",
				"_fsync(evidence_fd)",
				"_unlink(evidence_fd, content_name)",
				"_fsync(evidence_fd)",
				"_unlink(evidence_fd, plan_name)",
				"_fsync(evidence_fd)",
				"_rmdir(generation_fd, _WORKSPACE_EVIDENCE)",
				"_fsync(generation_fd)",
				"_v5_require_absent(generation_fd, _WORKSPACE_EVIDENCE)",
			]),
		).toBe(true);
		const probe = `import importlib.util,os,shutil,struct,sys,tempfile
spec=importlib.util.spec_from_file_location("store_v5_b_probe",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
lifecycle=bytearray(range(32))
generation=bytearray(range(32,64))
binding=bytes(range(64,96))
tx=bytes((1,))+bytes(31)
plan_digest=bytes(range(96,128))
plan_nonce=bytes((7,))*32
content_nonce=bytes((8,))*32
manifest_nonce=bytes((9,))*32
plan=b"PIWSPLN1"+struct.pack(">I",17)
content=b"PIWSCNT1"+struct.pack(">Q",23)
manifest=b"PIWSIMF5"+bytes(8)+bytes(lifecycle)+bytes(generation)+binding+tx+plan_digest+struct.pack(">I",17)+struct.pack(">Q",23)+plan_nonce+content_nonce+bytes(20)
count=0

def write_exact(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  offset=0
  while offset<len(data):
   written=os.write(fd,data[offset:])
   if written<=0:raise RuntimeError("write")
   offset+=written
 finally:os.close(fd)

def one(plan_size=None,content_size=None,manifest_size=None):
 global count
 parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
 root=tempfile.mkdtemp(prefix="store-v5-b-",dir=parent)
 try:
  generation_path=os.path.join(root,"generation")
  evidence_path=os.path.join(generation_path,"workspace-evidence")
  os.mkdir(generation_path,0o700)
  os.mkdir(evidence_path,0o700)
  if plan_size is not None:write_exact(os.path.join(evidence_path,".ws-plan."+plan_nonce.hex()),plan[:plan_size])
  if content_size is not None:write_exact(os.path.join(evidence_path,".ws-content."+content_nonce.hex()),content[:content_size])
  if manifest_size is not None:write_exact(os.path.join(evidence_path,".ws-input-manifest-tmp."+manifest_nonce.hex()),manifest[:manifest_size])
  generation_fd=os.open(generation_path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  fds=module.Fds();fds.add(generation_fd)
  try:
   device=os.fstat(generation_fd).st_dev
   if module._v5_recover_input_begin_prefix(fds,generation_fd,lifecycle,generation,os.getuid(),device) is not True:raise RuntimeError("result")
   if os.path.exists(evidence_path):raise RuntimeError("presence")
   if fds.uncertain or fds.items!=[generation_fd]:raise RuntimeError("descriptors")
  finally:
   if generation_fd in fds.items:fds.close(generation_fd)
  count+=1
 finally:shutil.rmtree(root,ignore_errors=True)

one()
for size in range(13):one(size)
for size in range(17):one(12,size)
for size in range(273):one(12,16,size)
if count!=304:raise RuntimeError("count")
print("V5_B00_B13_PREFIX_MATRIX_OK 304")
`;
		const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
		const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
			cwd: "/",
			env: {},
			timeout: 30_000,
			maxBuffer: 1024,
		});
		expect(stderr).toBe("");
		expect(stdout).toBe("V5_B00_B13_PREFIX_MATRIX_OK 304\n");
	});

	test("V5 B14-B21 recovery preserves canonical drafts and finishes publication", async () => {
		const source = await readFile(HELPER, "utf8");
		const recovery = pythonFunction(source, "_v5_recover_input_begin_prefix").body;
		for (const exact of [
			'_INPUT_MANIFEST = b"\\x69nput.manifest"',
			"def _v5_read_open_file(",
			"def _v5_validate_retained_file(",
			"def _v5_validate_named_file(",
		])
			expect(source).toContain(exact);
		expect(
			tokensInOrder(recovery, [
				"if canonical_present:",
				"manifest_source_fd, source_error = _open_file(",
				"manifest_destination_fd, destination_error = _open_file(",
				"if not _v5_same_inode(source_stat, destination_stat):",
				"_v5_input_manifest_prefix(",
				"manifest_destination_fd, destination_stat, uid, device, 2",
				"_fsync(evidence_fd)",
				"evidence_fd, manifest_name, destination_stat, uid, device, 2",
				"evidence_fd, _INPUT_MANIFEST, destination_stat, uid, device, 2",
				"_unlink(evidence_fd, manifest_name)",
				"_fsync(evidence_fd)",
				"_v5_require_absent(evidence_fd, manifest_name)",
				"final_entries = _list(evidence_fd)",
				"manifest_destination_fd, destination_stat, uid, device, 1",
				"evidence_fd, _INPUT_MANIFEST, final_stat, uid, device, 1",
			]),
		).toBe(true);
		const dispatch = pythonFunction(source, "_dispatch_v5").body;
		expect(dispatch).toContain(`if opcode == _WS_BEGIN:
        return _cmd_ws_begin(`);
	});

	test("V5 draft inventory reconstructs bounded reservations and emits exact transactions", async () => {
		const source = await readFile(HELPER, "utf8");
		for (const exact of [
			"_WS_TRANSACTION = 0x83",
			"_MAX_V5_ITEMS = 8",
			"_V5_ITEM_RESERVATION = 1100000000",
			"_V5_GLOBAL_RESERVATION = 8800000000",
			"_WS_TRANSACTION_SIZE = 401",
			"def _v5_collect_draft_transaction(",
			"def _v5_collect_inventory(",
			"def _cmd_v5_inventory(",
		])
			expect(source).toContain(exact);
		const collect = pythonFunction(source, "_v5_collect_inventory").body;
		expect(
			tokensInOrder(collect, [
				"entries = _list(root_fd)",
				"lifecycle_count > 1024",
				"_scan_lifecycle(",
				"allow_v5_evidence=True",
				"generation[0] != current_name",
				"_v5_collect_draft_transaction(",
				"items.append(item)",
				"len(items) > _MAX_V5_ITEMS",
				"outstanding += _V5_ITEM_RESERVATION - allocated",
				"len(items) * _V5_ITEM_RESERVATION > _V5_GLOBAL_RESERVATION",
				"return items, outstanding",
			]),
		).toBe(true);
		const command = pythonFunction(source, "_cmd_v5_inventory").body;
		expect(
			tokensInOrder(command, [
				"_v5_collect_inventory(",
				"_write_frame(1, _WS_TRANSACTION, items[index])",
				"_v5_zero_transactions(items)",
			]),
		).toBe(true);
		const hello = pythonFunction(source, "_v5_handle_hello").body;
		expect(
			tokensInOrder(hello, [
				"recover_v5_evidence=True",
				"items, reconstructed = _v5_collect_inventory(",
				"_v5_zero_transactions(items)",
				'return (_MODE_V5_READY, "v5_ready", None)',
			]),
		).toBe(true);
		const dispatch = pythonFunction(source, "_dispatch_v5").body;
		expect(
			tokensInOrder(dispatch, [
				"if opcode == _WS_INVENTORY:",
				"_cmd_v5_inventory(",
				'return (v5_mode, "done", None)',
				"if opcode == _WS_BEGIN:",
				"return _cmd_ws_begin(",
			]),
		).toBe(true);
		const probe = `import importlib.util,os,shutil,struct,sys,tempfile
spec=importlib.util.spec_from_file_location("store_v5_inventory_probe",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
lifecycle=bytearray(range(32));generation=bytearray(range(32,64));binding=bytes(range(64,96));tx=bytes((1,))+bytes(31);plan_digest=bytes(range(96,128));plan_nonce=bytes((7,))*32;content_nonce=bytes((8,))*32
plan=b"PIWSPLN1"+struct.pack(">I",17);content=b"PIWSCNT1"+struct.pack(">Q",23);manifest=b"PIWSIMF5"+bytes(8)+bytes(lifecycle)+bytes(generation)+binding+tx+plan_digest+struct.pack(">I",17)+struct.pack(">Q",23)+plan_nonce+content_nonce+bytes(20)
parent="/private/tmp" if sys.platform=="darwin" else "/tmp";root=tempfile.mkdtemp(prefix="store-v5-inventory-",dir=parent)
try:
 generation_path=os.path.join(root,"generation");evidence=os.path.join(generation_path,"workspace-evidence");os.mkdir(generation_path,0o700);os.mkdir(evidence,0o700)
 for name,data in ((".ws-plan."+plan_nonce.hex(),plan),(".ws-content."+content_nonce.hex(),content),("input.manifest",manifest)):
  path=os.path.join(evidence,name);fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.write(fd,data);os.close(fd)
 generation_fd=os.open(generation_path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds=module.Fds();fds.add(generation_fd)
 try:
  row,allocated=module._v5_collect_draft_transaction(fds,generation_fd,lifecycle,generation,os.getuid(),os.fstat(generation_fd).st_dev)
  expected=bytearray(401);expected[0:32]=lifecycle;expected[32:64]=generation;expected[64:96]=binding;expected[96:128]=tx;expected[128:160]=plan_digest;struct.pack_into(">I",expected,160,17);struct.pack_into(">Q",expected,164,23);expected[216:224]=bytes((255,))*8;expected[384:392]=bytes((255,))*8;struct.pack_into(">Q",expected,392,1100000000);expected[400]=1
  if allocated!=300 or row!=expected or fds.uncertain or fds.items!=[generation_fd]:raise RuntimeError("transaction")
  module._zero(row);module._zero(expected)
 finally:
  if generation_fd in fds.items:fds.close(generation_fd)
finally:shutil.rmtree(root,ignore_errors=True)
print("V5_DRAFT_TRANSACTION_OK 401 300")
`;
		const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
		const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
			cwd: "/",
			env: {},
			timeout: 30_000,
			maxBuffer: 1024,
		});
		expect(stderr).toBe("");
		expect(stdout).toBe("V5_DRAFT_TRANSACTION_OK 401 300\n");
	});

	test("V5 WS_INSPECT stays read-only, source-bound, and emits only exact selector rows", async () => {
		const source = await readFile(HELPER, "utf8");
		expect(source).toContain("_E_STALE = 0x12");
		const selection = pythonFunction(source, "_v5_inspect_row").body;
		expect(
			tokensInOrder(selection, [
				"lifecycle = payload[:32]",
				"if _same_at(item, 0, lifecycle):",
				"lifecycle_present = True",
				"if matched is None and _same_at(item, 0, payload):",
				"return matched, lifecycle_present",
				"_zero(lifecycle)",
			]),
		).toBe(true);
		for (const forbidden of ["_unlink(", "_rmdir(", "_fsync(", "_fdatasync(", "os.link", "_publish_", "_prove_"])
			expect(selection).not.toContain(forbidden);
		const command = pythonFunction(source, "_cmd_v5_inspect").body;
		expect(
			tokensInOrder(command, [
				"items, unused_outstanding = _v5_collect_inventory(",
				"matched, lifecycle_present = _v5_inspect_row(items, payload)",
				"return _E_STALE",
				"return _E_ABSENT",
				"_write_frame(1, _WS_TRANSACTION, matched)",
				"_v5_zero_transactions(items)",
			]),
		).toBe(true);
		for (const forbidden of [
			"_unlink(",
			"_rmdir(",
			"_fsync(",
			"_fdatasync(",
			"os.link",
			"_publish_",
			"_prove_",
			"_write_temp",
		])
			expect(command).not.toContain(forbidden);
		const dispatch = pythonFunction(source, "_dispatch_v5").body;
		expect(
			tokensInOrder(dispatch, [
				"if opcode == _WS_INVENTORY:",
				"if opcode == _WS_INSPECT:",
				"error = _cmd_v5_inspect(",
				"if error is not None:",
				'return (v5_mode, "error", error)',
				'return (v5_mode, "done", None)',
				"if opcode == _WS_BEGIN:",
				"return _cmd_ws_begin(",
				'return (v5_mode, "error", _E_ABSENT)',
			]),
		).toBe(true);
	});

	const linuxProbeTest = process.platform === "linux" ? test : test.skip;

	linuxProbeTest(
		"V5 WS_INSPECT dispatch serves exact rows, fixed arms, and malformed pre-effect on an authentic root",
		async () => {
			const probe = `import importlib.util,os,shutil,struct,sys,tempfile
spec=importlib.util.spec_from_file_location("store_v5_inspect_command_probe",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
lifecycle=bytearray(range(32));generation=bytearray(range(32,64));binding=bytes(range(64,96));tx=bytes((1,))+bytes(31);plan_digest=bytes(range(96,128));plan_nonce=bytes((7,))*32;content_nonce=bytes((8,))*32
plan=b"PIWSPLN1"+struct.pack(">I",17);content=b"PIWSCNT1"+struct.pack(">Q",23);manifest=b"PIWSIMF5"+bytes(8)+bytes(lifecycle)+bytes(generation)+binding+tx+plan_digest+struct.pack(">I",17)+struct.pack(">Q",23)+plan_nonce+content_nonce+bytes(20)
expected=bytearray(401);expected[0:32]=lifecycle;expected[32:64]=generation;expected[64:96]=binding;expected[96:128]=tx;expected[128:160]=plan_digest;struct.pack_into(">I",expected,160,17);struct.pack_into(">Q",expected,164,23);expected[216:224]=bytes((255,))*8;expected[384:392]=bytes((255,))*8;struct.pack_into(">Q",expected,392,1100000000);expected[400]=1
selector=bytearray(lifecycle)+bytearray(generation)+bytearray(binding)+bytearray(tx)
parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
def captured(call):
 read_fd,write_fd=os.pipe();saved=os.dup(1);closed=False
 try:
  os.dup2(write_fd,1)
  try:call()
  finally:os.dup2(saved,1)
  os.close(write_fd);closed=True
  chunks=[]
  while True:
   chunk=os.read(read_fd,65536)
   if not chunk:break
   chunks.append(chunk)
  return b"".join(chunks)
 finally:
  if not closed:os.close(write_fd)
  os.close(saved);os.close(read_fd)
def build(extra,alias):
 root=tempfile.mkdtemp(prefix="store-v5-inspect-cmd-",dir=parent)
 fds=None
 try:
  root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds=module.Fds();fds.add(root_fd)
  root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
  lock_fd,lock_device,lock_inode,lock_error=module._bind_lock(fds,root_fd,os.getuid(),root_device)
  if lock_error is not None:raise RuntimeError("lock")
  genesis=bytes(range(64));identity_digest=module._digest(genesis)
  record=bytearray(module._WAL_SIZE);record[:11]=module._WAL_MAGIC;record[16]=module._W_ALLOCATED;struct.pack_into(">Q",record,24,1);record[32:64]=lifecycle;record[64:96]=generation;record[96:128]=module._ZERO32;record[128:160]=identity_digest
  payload=bytes(lifecycle)+bytes(generation)+struct.pack(">I",len(genesis))+genesis+bytes(record)
  module._zero(identity_digest)
  result,create_error=module._cmd_create(fds,root_fd,payload,os.getuid(),root_device)
  if create_error is not None:raise RuntimeError("create")
  suffix=plan_nonce if alias else content_nonce
  evidence=os.path.join(root,lifecycle.hex(),"generations",generation.hex(),"workspace-evidence")
  os.mkdir(evidence,0o700)
  for name,data in ((".ws-plan."+plan_nonce.hex(),plan),(".ws-content."+suffix.hex(),content),("input.manifest",manifest)):
   path=os.path.join(evidence,name);fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.write(fd,data);os.close(fd)
  if extra:
   fd=os.open(os.path.join(evidence,"residue.rec"),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.write(fd,b"x");os.close(fd)
  return root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode
 except BaseException:
  if fds is not None:fds.close_all()
  shutil.rmtree(root,ignore_errors=True)
  raise
def dispatch_inspect(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,payload):
 box=[]
 def call():
  box.append(module._dispatch_v5(fds,root_fd,os.getuid(),root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_INSPECT,payload,module._MODE_V5_READY))
 emitted=captured(call)
 return box[0],emitted
def arms(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode):
 frame=struct.pack(">BI",0x83,401)+bytes(expected)
 outcome,emitted=dispatch_inspect(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,selector)
 if outcome!=(module._MODE_V5_READY,"done",None) or emitted!=frame or len(emitted)!=406:raise RuntimeError("exact")
 outcome,emitted=dispatch_inspect(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,selector)
 if outcome!=(module._MODE_V5_READY,"done",None) or emitted!=frame or len(emitted)!=406:raise RuntimeError("repeat")
 for offset in (32,64,96):
  stale=bytearray(selector);stale[offset:offset+32]=bytes(range(96,128))
  outcome,emitted=dispatch_inspect(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,stale)
  if outcome!=(module._MODE_V5_READY,"error",module._E_STALE) or emitted!=b"":raise RuntimeError("stale")
 absent=bytearray(selector);absent[0:32]=bytearray(range(64,96))
 outcome,emitted=dispatch_inspect(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,absent)
 if outcome!=(module._MODE_V5_READY,"error",module._E_ABSENT) or emitted!=b"":raise RuntimeError("absent")
 for bad in (bytearray(127),bytearray(129)):
  outcome,emitted=dispatch_inspect(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,bad)
  if outcome!=(module._MODE_V5_READY,"error",module._E_INPUT) or emitted!=b"":raise RuntimeError("malformed")
 zero_tx=bytearray(selector);zero_tx[96:128]=bytes(32)
 outcome,emitted=dispatch_inspect(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,zero_tx)
 if outcome!=(module._MODE_V5_READY,"error",module._E_INPUT) or emitted!=b"":raise RuntimeError("zero-tx")
 outcome,emitted=dispatch_inspect(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,selector)
 if outcome!=(module._MODE_V5_READY,"done",None) or emitted!=frame or len(emitted)!=406:raise RuntimeError("post-malformed")
 items,outstanding=module._v5_collect_inventory(fds,root_fd,os.getuid(),root_device,root_inode,lock_fd,lock_device,lock_inode)
 if len(items)!=1 or items[0]!=expected:raise RuntimeError("inventory")
 module._v5_zero_transactions(items)
 if any(items[0]):raise RuntimeError("zeroed")
 outcome,emitted=dispatch_inspect(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,selector)
 if outcome!=(module._MODE_V5_READY,"done",None) or emitted!=frame or len(emitted)!=406:raise RuntimeError("post-zero")
 if fds.uncertain or fds.items!=[root_fd,lock_fd]:raise RuntimeError("fds")
for attempt in (0,1):
 root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=build(False,False)
 try:
  arms(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode)
 finally:
  fds.close_all();shutil.rmtree(root,ignore_errors=True)
module._zero(expected)
print("V5_INSPECT_COMMAND_OK 8 406")
`;
			const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
			const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
				cwd: "/",
				env: {},
				timeout: 30_000,
				maxBuffer: 1024,
			});
			expect(stderr).toBe("");
			expect(stdout).toBe("V5_INSPECT_COMMAND_OK 8 406\n");
		},
	);

	linuxProbeTest(
		"V5 WS_INSPECT emits no frame on corrupt or aliased evidence and keeps descriptor discipline",
		async () => {
			const probe = `import importlib.util,os,shutil,struct,sys,tempfile
spec=importlib.util.spec_from_file_location("store_v5_inspect_fatal_probe",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
lifecycle=bytearray(range(32));generation=bytearray(range(32,64));binding=bytes(range(64,96));tx=bytes((1,))+bytes(31);plan_digest=bytes(range(96,128));plan_nonce=bytes((7,))*32;content_nonce=bytes((8,))*32
plan=b"PIWSPLN1"+struct.pack(">I",17);content=b"PIWSCNT1"+struct.pack(">Q",23);manifest=b"PIWSIMF5"+bytes(8)+bytes(lifecycle)+bytes(generation)+binding+tx+plan_digest+struct.pack(">I",17)+struct.pack(">Q",23)+plan_nonce+content_nonce+bytes(20)
selector=bytearray(lifecycle)+bytearray(generation)+bytearray(binding)+bytearray(tx)
parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
def captured(call):
 read_fd,write_fd=os.pipe();saved=os.dup(1);closed=False
 try:
  os.dup2(write_fd,1)
  try:call()
  finally:os.dup2(saved,1)
  os.close(write_fd);closed=True
  chunks=[]
  while True:
   chunk=os.read(read_fd,65536)
   if not chunk:break
   chunks.append(chunk)
  return b"".join(chunks)
 finally:
  if not closed:os.close(write_fd)
  os.close(saved);os.close(read_fd)
def build(extra,alias):
 root=tempfile.mkdtemp(prefix="store-v5-inspect-fatal-",dir=parent)
 fds=None
 try:
  root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds=module.Fds();fds.add(root_fd)
  root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
  lock_fd,lock_device,lock_inode,lock_error=module._bind_lock(fds,root_fd,os.getuid(),root_device)
  if lock_error is not None:raise RuntimeError("lock")
  genesis=bytes(range(64));identity_digest=module._digest(genesis)
  record=bytearray(module._WAL_SIZE);record[:11]=module._WAL_MAGIC;record[16]=module._W_ALLOCATED;struct.pack_into(">Q",record,24,1);record[32:64]=lifecycle;record[64:96]=generation;record[96:128]=module._ZERO32;record[128:160]=identity_digest
  payload=bytes(lifecycle)+bytes(generation)+struct.pack(">I",len(genesis))+genesis+bytes(record)
  module._zero(identity_digest)
  result,create_error=module._cmd_create(fds,root_fd,payload,os.getuid(),root_device)
  if create_error is not None:raise RuntimeError("create")
  suffix=plan_nonce if alias else content_nonce
  evidence=os.path.join(root,lifecycle.hex(),"generations",generation.hex(),"workspace-evidence")
  os.mkdir(evidence,0o700)
  for name,data in ((".ws-plan."+plan_nonce.hex(),plan),(".ws-content."+suffix.hex(),content),("input.manifest",manifest)):
   path=os.path.join(evidence,name);fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.write(fd,data);os.close(fd)
  if extra:
   fd=os.open(os.path.join(evidence,"residue.rec"),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.write(fd,b"x");os.close(fd)
  return root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode
 except BaseException:
  if fds is not None:fds.close_all()
  shutil.rmtree(root,ignore_errors=True)
  raise
def expect_fatal(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode):
 seen=[]
 def call():
  try:
   module._dispatch_v5(fds,root_fd,os.getuid(),root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_INSPECT,selector,module._MODE_V5_READY)
  except module.Fatal as failure:
   seen.append(failure.code)
 emitted=captured(call)
 if len(seen)!=1:return None,emitted
 return seen[0],emitted
for extra,alias,label in ((True,False,"corrupt"),(False,True,"alias")):
 root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=build(extra,alias)
 try:
  code,emitted=expect_fatal(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode)
  if code!=module._E_STATE or emitted!=b"" or fds.uncertain or fds.items!=[root_fd,lock_fd]:raise RuntimeError(label)
 finally:
  fds.close_all();shutil.rmtree(root,ignore_errors=True)
print("V5_INSPECT_FATAL_OK 14 14")
`;
			const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
			const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
				cwd: "/",
				env: {},
				timeout: 30_000,
				maxBuffer: 1024,
			});
			expect(stderr).toBe("");
			expect(stdout).toBe("V5_INSPECT_FATAL_OK 14 14\n");
		},
	);

	test("V5 WS_BEGIN admission, quota, and publication stay source-bound", async () => {
		const source = await readFile(HELPER, "utf8");
		for (const exact of [
			"_E_QUOTA = 0x13",
			"_V5_FLOOR_BYTES = 4294967296",
			"_V5_U64_MAX = 18446744073709551615",
			"_V5_EVIDENCE_PREFIXES = (_PLAN_DRAFT_PREFIX, _CONTENT_DRAFT_PREFIX, _INPUT_MANIFEST_TEMP_PREFIX)",
			"def _v5_available_bytes(",
			"def _v5_write_prefix(",
			"def _v5_validate_written(",
			"def _v5_create_nonce_file(",
			"def _cmd_ws_begin(",
		])
			expect(source).toContain(exact);
		const available = pythonFunction(source, "_v5_available_bytes").body;
		expect(
			tokensInOrder(available, [
				"counts = os.fstatvfs(fd)",
				"raise Fatal(_E_IO)",
				"frsize = counts.f_frsize",
				"available = counts.f_bavail",
				"if frsize <= 0 or frsize > _V5_U64_MAX or available < 0 or available > _V5_U64_MAX // frsize:",
				"return available * frsize",
			]),
		).toBe(true);
		const create = pythonFunction(source, "_v5_create_nonce_file").body;
		expect(
			tokensInOrder(create, [
				"flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC",
				"entries = _list(parent)",
				"if entries != expected:",
				"nonce = bytearray(os.urandom(32))",
				"if _all_zero(nonce):",
				"name = prefix + _hex_name(nonce)",
				"if found is not None or error != errno.ENOENT:",
				"present_suffix = _v5_random_suffix(entries[index], entry_prefix)",
				"if _same(present_suffix, nonce):",
				"fd, open_error = _open_raw(fds, parent, name, flags, 0o600)",
				"if open_error != errno.EEXIST:",
				"except BaseException:",
				"_zero(nonce)",
				"fds.close(fd)",
				"if fds.uncertain:",
				"raise Fatal(_E_UNCERTAIN)",
				"return fd, name, nonce",
			]),
		).toBe(true);
		const command = pythonFunction(source, "_cmd_ws_begin").body;
		expect(
			tokensInOrder(command, [
				"lifecycle = payload[0:32]",
				"items, outstanding = _v5_collect_inventory(",
				"if _same_at(item, 0, lifecycle):",
				"if matched is None and _same_at(item, 0, payload):",
				"response = bytearray(25)",
				"response[0] = _WS_BEGIN",
				"response[1:9] = matched[204:212]",
				"response[9:17] = matched[180:188]",
				"response[17:25] = matched[188:196]",
				"_write_frame(1, _OK, response)",
				'return (v5_mode, "emitted", None)',
				"if lifecycle_present:",
				'return (v5_mode, "error", _E_EXISTS)',
				"lifecycle_fd, open_error = _open_dir(fds, root_fd, lifecycle_name, uid, device)",
				"if open_error == errno.ENOENT:",
				'return (v5_mode, "error", _E_BUSY)',
				"_scan_lifecycle(fds, lifecycle_fd, lifecycle, uid, device, False, allow_v5_evidence=True)",
				"if not _same_at(payload, 32, current_generation):",
				"current_entry = _find_generation(scan[6], current_name)",
				"evidence_fd, evidence_error = _open_dir(fds, generation_fd, _WORKSPACE_EVIDENCE, uid, device)",
				"if evidence_error != errno.ENOENT:",
				"if len(items) + 1 > _MAX_V5_ITEMS:",
				'return (v5_mode, "error", _E_QUOTA)',
				"(len(items) + 1) * _V5_ITEM_RESERVATION > _V5_GLOBAL_RESERVATION",
				"required = outstanding + _V5_ITEM_RESERVATION + _V5_FLOOR_BYTES",
				"if _v5_available_bytes(root_fd) < required:",
				"manifest[0:8] = _INPUT_MANIFEST_MAGIC",
				"manifest[16:48] = lifecycle",
				"evidence_fd, created = _make_dir(fds, generation_fd, _WORKSPACE_EVIDENCE, uid, device)",
				"if not created:",
				"plan_fd, plan_name, plan_suffix = _v5_create_nonce_file(",
				"_v5_write_prefix(plan_fd, plan_header)",
				"_v5_validate_written(",
				"_fdatasync(plan_fd)",
				"_fsync(evidence_fd)",
				"content_fd, content_name, content_suffix = _v5_create_nonce_file(",
				"manifest[188:220] = plan_suffix",
				"manifest[220:252] = content_suffix",
				"_v5_write_prefix(content_fd, content_header)",
				"_fdatasync(content_fd)",
				"manifest_fd, manifest_name, manifest_suffix = _v5_create_nonce_file(",
				"_v5_write_prefix(manifest_fd, manifest)",
				"_fdatasync(manifest_fd)",
				"follow_symlinks=False",
				"_validate_file_stat(alias, uid, device, 2)",
				"if not _v5_same_inode(alias, manifest_stat):",
				"if not linked:",
				"if not _v5_same_inode(canonical, alias):",
				"raise Fatal(_E_STATE)",
				"destination_fd, destination_error = _open_file(",
				"if not _v5_same_inode(destination_stat, manifest_stat):",
				"_unlink(evidence_fd, manifest_name)",
				"_v5_require_absent(evidence_fd, manifest_name)",
				"final_stat = _v5_validate_retained_file(destination_fd, destination_stat, uid, device, 1)",
				"_v5_validate_named_file(evidence_fd, _INPUT_MANIFEST, final_stat, uid, device, 1)",
				"if final_entries != sorted([plan_name, content_name, _INPUT_MANIFEST]):",
				"fds.close(destination_fd)",
				"fds.close(evidence_fd)",
				"_close_scan(fds, scan)",
				"fds.close(lifecycle_fd)",
				"lifecycle_fd = None",
				"if fds.uncertain:",
				"raise Fatal(_E_UNCERTAIN)",
				'struct.pack_into(">Q", response, 1, 0)',
				'struct.pack_into(">Q", response, 9, 0)',
				'struct.pack_into(">Q", response, 17, 0)',
			]),
		).toBe(true);
		expect(command).not.toContain("_ok_payload");
		expect(command).not.toContain("os.statvfs");
	});

	test("V5 WS_BEGIN nonce namespaces retry legal races without weakening entry authority", async () => {
		const probe = `import importlib.util,os,shutil,sys,tempfile
source=open(sys.argv[1]).read()
uid=os.getuid()
parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
counter=[0]
def mutated(replacements):
 text=source
 for anchor,replacement in replacements:
  if text.count(anchor)!=1:raise RuntimeError("anchor")
  text=text.replace(anchor,replacement,1)
 counter[0]+=1
 path=os.path.join(parent,"ws-nonce-mod-%d.py"%counter[0])
 handle=open(path,"w")
 handle.write(text)
 handle.close()
 try:
  spec=importlib.util.spec_from_file_location("ws_nonce_mod_%d"%counter[0],path)
  module=importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
 finally:
  os.unlink(path)
 return module
def fresh():
 root=tempfile.mkdtemp(prefix="ws-nonce-dir-",dir=parent)
 dir_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 return root,dir_fd
def written(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 os.write(fd,data);os.close(fd)
def_line="def _v5_create_nonce_file(fds, parent, prefix, expected, uid, device):"
draw="        nonce = bytearray(os.urandom(32))"
counter_draw="        nonce = bytearray(bytes([_V5_PROBE_STEP[0]]) + bytes(31))\\n        _V5_PROBE_STEP[0] += 1"
open_call="            fd, open_error = _open_raw(fds, parent, name, flags, 0o600)"
race_open="            fd, open_error = _v5_probe_race_open(fds, parent, name, flags, 0o600)"
# suffix collision: first draw equals a still-present recognized plan suffix, retry uses a fresh draw
module=mutated([
 (def_line,"_V5_PROBE_STEP = [7]\\n\\n\\n"+def_line),
 (draw,counter_draw),
])
root,dir_fd=fresh()
fds=None
try:
 plan_name=b".ws-plan."+(bytes([7])+bytes(31)).hex().encode()
 written(os.path.join(root,plan_name.decode()),b"x")
 fds=module.Fds();fds.add(dir_fd)
 device=os.fstat(dir_fd).st_dev
 created_fd,created_name,created_nonce=module._v5_create_nonce_file(fds,dir_fd,b".ws-content.",[plan_name],uid,device)
 if created_name!=b".ws-content."+(bytes([8])+bytes(31)).hex().encode():raise RuntimeError("collision-name")
 if sorted(os.listdir(root))!=[created_name.decode(),plan_name.decode()]:raise RuntimeError("collision-entries")
 if open(os.path.join(root,plan_name.decode()),"rb").read()!=b"x":raise RuntimeError("collision-untouched")
 module._zero(created_nonce);fds.close(created_fd);fds.close(dir_fd)
finally:
 if fds is not None:fds.close_all()
 shutil.rmtree(root)
# transient EEXIST race: the racer creates the exact absent candidate between the helper checks and the
# creating syscall, then removes it; production retries with one new draw and all checks intact
module=mutated([
 (def_line,"_V5_PROBE_STEP = [9]\\n_V5_PROBE_ONCE = [True]\\n\\n\\ndef _v5_probe_race_open(fds, parent, name, flags, mode):\\n    if not _V5_PROBE_ONCE[0]:\\n        return _open_raw(fds, parent, name, flags, mode)\\n    _V5_PROBE_ONCE[0] = False\\n    raced_fd = os.open(name, flags | os.O_CREAT | os.O_EXCL, mode, dir_fd=parent)\\n    os.close(raced_fd)\\n    fd, open_error = _open_raw(fds, parent, name, flags, mode)\\n    if fd is None and open_error == errno.EEXIST:\\n        os.unlink(name, dir_fd=parent)\\n    return fd, open_error\\n\\n\\n"+def_line),
 (draw,counter_draw),
 (open_call,race_open),
])
root,dir_fd=fresh()
fds=None
try:
 fds=module.Fds();fds.add(dir_fd)
 device=os.fstat(dir_fd).st_dev
 created_fd,created_name,created_nonce=module._v5_create_nonce_file(fds,dir_fd,b".ws-content.",[],uid,device)
 if created_name!=b".ws-content."+(bytes([10])+bytes(31)).hex().encode():raise RuntimeError("exist-name")
 if os.listdir(root)!=[created_name.decode()]:raise RuntimeError("exist-entries")
 if fds.uncertain or fds.items!=[dir_fd,created_fd]:raise RuntimeError("exist-fds")
 module._zero(created_nonce);fds.close(created_fd);fds.close(dir_fd)
finally:
 if fds is not None:fds.close_all()
 shutil.rmtree(root)
# persistent raced extra: the racer leaves its file in place; the unweakened entry-set authority
# fails closed and the helper creates nothing
module=mutated([
 (def_line,"_V5_PROBE_STEP = [9]\\n_V5_PROBE_ONCE = [True]\\n\\n\\ndef _v5_probe_race_open(fds, parent, name, flags, mode):\\n    if not _V5_PROBE_ONCE[0]:\\n        return _open_raw(fds, parent, name, flags, mode)\\n    _V5_PROBE_ONCE[0] = False\\n    raced_fd = os.open(name, flags | os.O_CREAT | os.O_EXCL, mode, dir_fd=parent)\\n    os.close(raced_fd)\\n    return _open_raw(fds, parent, name, flags, mode)\\n\\n\\n"+def_line),
 (draw,counter_draw),
 (open_call,race_open),
])
root,dir_fd=fresh()
fds=None
try:
 fds=module.Fds();fds.add(dir_fd)
 device=os.fstat(dir_fd).st_dev
 seen=[]
 try:
  module._v5_create_nonce_file(fds,dir_fd,b".ws-content.",[],uid,device)
 except module.Fatal as failure:
  seen.append(failure.code)
 raced=".ws-content."+(bytes([9])+bytes(31)).hex()
 if seen!=[module._E_STATE]:raise RuntimeError("raced-code")
 if sorted(os.listdir(root))!=[raced]:raise RuntimeError("raced-entries")
 if open(os.path.join(root,raced),"rb").read()!=b"":raise RuntimeError("raced-untouched")
 if fds.uncertain or fds.items!=[dir_fd]:raise RuntimeError("raced-fds")
finally:
 if fds is not None:fds.close_all()
 shutil.rmtree(root)
# post-open validation failure: the racer removes the created name after the open, so the retained
# open descriptor reports nlink zero and the fd-stat validation fails closed with NLINK; the
# production except zeroes the drawn nonce first, closes the descriptor, and raises without residue
module=mutated([
 (def_line,"_V5_PROBE_ONCE = [True]\\n_V5_PROBE_NONCE = [None]\\n\\n\\ndef _v5_probe_race_open(fds, parent, name, flags, mode):\\n    if not _V5_PROBE_ONCE[0]:\\n        return _open_raw(fds, parent, name, flags, mode)\\n    _V5_PROBE_ONCE[0] = False\\n    fd, open_error = _open_raw(fds, parent, name, flags, mode)\\n    if fd is not None:\\n        os.unlink(name, dir_fd=parent)\\n    return fd, open_error\\n\\n\\n"+def_line),
 (draw,draw+"\\n        _V5_PROBE_NONCE[0] = nonce"),
 (open_call,race_open),
])
root,dir_fd=fresh()
fds=None
try:
 fds=module.Fds();fds.add(dir_fd)
 device=os.fstat(dir_fd).st_dev
 seen=[]
 try:
  module._v5_create_nonce_file(fds,dir_fd,b".ws-content.",[],uid,device)
 except module.Fatal as failure:
  seen.append(failure.code)
 if seen!=[module._E_NLINK]:raise RuntimeError("postopen-code")
 retained=module._V5_PROBE_NONCE[0]
 if retained is None or len(retained)!=32 or any(retained):raise RuntimeError("postopen-zero")
 if os.listdir(root)!=[]:raise RuntimeError("postopen-entries")
 if fds.uncertain or fds.items!=[dir_fd]:raise RuntimeError("postopen-fds")
finally:
 if fds is not None:fds.close_all()
 shutil.rmtree(root)
print("V5_WS_BEGIN_NONCE_OK 4")
`;
		const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
		const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
			cwd: "/",
			env: {},
			timeout: 30_000,
			maxBuffer: 1024,
		});
		expect(stderr).toBe("");
		expect(stdout).toBe("V5_WS_BEGIN_NONCE_OK 4\n");
	});

	linuxProbeTest("V5 WS_BEGIN admits, retries, and refuses on a real root", async () => {
		const probe = `import importlib.util,os,shutil,struct,sys,tempfile
spec=importlib.util.spec_from_file_location("store_v5_begin_probe",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
lifecycle=bytearray(range(32));generation=bytearray(range(32,64));binding=bytes(range(64,96));tx=bytes((1,))+bytes(31);plan_digest=bytes(range(96,128))
uid=os.getuid()
parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
def captured(call):
 read_fd,write_fd=os.pipe();saved=os.dup(1);closed=False
 try:
  os.dup2(write_fd,1)
  try:call()
  finally:os.dup2(saved,1)
  os.close(write_fd);closed=True
  chunks=[]
  while True:
   chunk=os.read(read_fd,65536)
   if not chunk:break
   chunks.append(chunk)
  return b"".join(chunks)
 finally:
  if not closed:os.close(write_fd)
  os.close(saved);os.close(read_fd)
def request(lifecycle_bytes,generation_bytes,tx_bytes):
 payload=bytearray(172);payload[0:32]=lifecycle_bytes;payload[32:64]=generation_bytes;payload[64:96]=binding;payload[96:128]=tx_bytes;payload[128:160]=plan_digest;struct.pack_into(">I",payload,160,17);struct.pack_into(">Q",payload,164,23)
 return payload
def build():
 root=tempfile.mkdtemp(prefix="store-v5-begin-",dir=parent)
 fds=None
 try:
  root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds=module.Fds();fds.add(root_fd)
  root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
  lock_fd,lock_device,lock_inode,lock_error=module._bind_lock(fds,root_fd,uid,root_device)
  if lock_error is not None:raise RuntimeError("lock")
  genesis=bytes(range(64));identity_digest=module._digest(genesis)
  record=bytearray(module._WAL_SIZE);record[:11]=module._WAL_MAGIC;record[16]=module._W_ALLOCATED;struct.pack_into(">Q",record,24,1);record[32:64]=lifecycle;record[64:96]=generation;record[96:128]=module._ZERO32;record[128:160]=identity_digest
  payload=bytes(lifecycle)+bytes(generation)+struct.pack(">I",len(genesis))+genesis+bytes(record)
  module._zero(identity_digest)
  result,create_error=module._cmd_create(fds,root_fd,payload,uid,root_device)
  if create_error is not None:raise RuntimeError("create")
  return root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode
 except BaseException:
  if fds is not None:fds.close_all()
  shutil.rmtree(root)
  raise
def dispatch(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,opcode,payload):
 box=[]
 def call():
  box.append(module._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,opcode,payload,module._MODE_V5_READY))
 emitted=captured(call)
 return box[0],emitted
root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=build()
expected=None
try:
 stale=bytearray(generation);stale[0]=255
 outcome,emitted=dispatch(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_BEGIN,request(lifecycle,stale,tx))
 if outcome!=(module._MODE_V5_READY,"error",module._E_BUSY) or emitted!=b"":raise RuntimeError("generation")
 outcome,emitted=dispatch(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_BEGIN,request(bytearray(range(200,232)),generation,tx))
 if outcome!=(module._MODE_V5_READY,"error",module._E_BUSY) or emitted!=b"":raise RuntimeError("lifecycle")
 selector=request(lifecycle,generation,tx)
 frame=struct.pack(">BI",0x80,25)+bytes((0x0A,))+bytes(24)
 outcome,emitted=dispatch(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_BEGIN,selector)
 if outcome!=(module._MODE_V5_READY,"emitted",None) or emitted!=frame:raise RuntimeError("begin")
 evidence=os.path.join(root,lifecycle.hex(),"generations",generation.hex(),"workspace-evidence")
 entries=sorted(os.listdir(evidence))
 if len(entries)!=3 or "input.manifest" not in entries:raise RuntimeError("entries")
 plan_name=[name for name in entries if name.startswith(".ws-plan.")][0]
 content_name=[name for name in entries if name.startswith(".ws-content.")][0]
 if open(os.path.join(evidence,plan_name),"rb").read()!=b"PIWSPLN1"+struct.pack(">I",17):raise RuntimeError("plan")
 if open(os.path.join(evidence,content_name),"rb").read()!=b"PIWSCNT1"+struct.pack(">Q",23):raise RuntimeError("content")
 manifest=open(os.path.join(evidence,"input.manifest"),"rb").read()
 if len(manifest)!=272 or manifest[:8]!=b"PIWSIMF5" or manifest[8:16]!=bytes(8):raise RuntimeError("manifest")
 if manifest[16:48]!=bytes(lifecycle) or manifest[48:80]!=bytes(generation) or manifest[80:112]!=binding:raise RuntimeError("identity")
 if manifest[112:144]!=tx or manifest[144:176]!=plan_digest:raise RuntimeError("fields")
 if struct.unpack_from(">I",manifest,176)[0]!=17 or struct.unpack_from(">Q",manifest,180)[0]!=23:raise RuntimeError("lengths")
 if manifest[188:220]!=bytes.fromhex(plan_name[9:]) or manifest[220:252]!=bytes.fromhex(content_name[12:]):raise RuntimeError("nonces")
 if manifest[252:272]!=bytes(20):raise RuntimeError("committed")
 for name in entries:
  info=os.stat(os.path.join(evidence,name))
  if oct(info.st_mode&0o777)!="0o600" or info.st_nlink!=1:raise RuntimeError("file")
 if oct(os.stat(evidence).st_mode&0o777)!="0o700":raise RuntimeError("dir")
 if fds.uncertain or fds.items!=[root_fd,lock_fd]:raise RuntimeError("fds")
 outcome,emitted=dispatch(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_BEGIN,selector)
 if outcome!=(module._MODE_V5_READY,"emitted",None) or emitted!=frame:raise RuntimeError("retry")
 if sorted(os.listdir(evidence))!=entries:raise RuntimeError("retry-entries")
 outcome,emitted=dispatch(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_BEGIN,request(lifecycle,generation,bytes((2,))+bytes(31)))
 if outcome!=(module._MODE_V5_READY,"error",module._E_EXISTS) or emitted!=b"":raise RuntimeError("mismatch")
 if sorted(os.listdir(evidence))!=entries:raise RuntimeError("mismatch-entries")
 items,outstanding=module._v5_collect_inventory(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode)
 expected=bytearray(401);expected[0:32]=lifecycle;expected[32:64]=generation;expected[64:96]=binding;expected[96:128]=tx;expected[128:160]=plan_digest;struct.pack_into(">I",expected,160,17);struct.pack_into(">Q",expected,164,23);expected[216:224]=bytes((255,))*8;expected[384:392]=bytes((255,))*8;struct.pack_into(">Q",expected,392,1100000000);expected[400]=1
 if len(items)!=1 or items[0]!=expected:raise RuntimeError("inventory")
 if outstanding!=1100000000-300:raise RuntimeError("outstanding")
 module._v5_zero_transactions(items)
 generation_fd=os.open(os.path.dirname(evidence),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 recover_fds=module.Fds();recover_fds.add(generation_fd)
 if module._v5_recover_input_begin_prefix(recover_fds,generation_fd,lifecycle,generation,uid,os.fstat(generation_fd).st_dev) is not True:raise RuntimeError("recovery")
 recover_fds.close(generation_fd)
 if sorted(os.listdir(evidence))!=entries:raise RuntimeError("recovery-entries")
 outcome,emitted=dispatch(fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_INSPECT,bytearray(selector[:128]))
 if outcome!=(module._MODE_V5_READY,"done",None) or emitted!=struct.pack(">BI",0x83,401)+bytes(expected):raise RuntimeError("inspect")
 if fds.uncertain or fds.items!=[root_fd,lock_fd]:raise RuntimeError("final-fds")
finally:
 fds.close_all();shutil.rmtree(root)
 if expected is not None:module._zero(expected)
print("V5_WS_BEGIN_COMMAND_OK 25 172")
`;
		const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
		const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
			cwd: "/",
			env: {},
			timeout: 30_000,
			maxBuffer: 1024,
		});
		expect(stderr).toBe("");
		expect(stdout).toBe("V5_WS_BEGIN_COMMAND_OK 25 172\n");
	});

	linuxProbeTest("V5 WS_BEGIN enforces real capacity boundaries before mutation", async () => {
		const probe = `import importlib.util,os,shutil,struct,sys,tempfile
spec=importlib.util.spec_from_file_location("store_v5_quota_probe",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
uid=os.getuid()
parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
frame=struct.pack(">BI",0x80,25)+bytes((0x0A,))+bytes(24)
def captured(call):
 read_fd,write_fd=os.pipe();saved=os.dup(1);closed=False
 try:
  os.dup2(write_fd,1)
  try:call()
  finally:os.dup2(saved,1)
  os.close(write_fd);closed=True
  chunks=[]
  while True:
   chunk=os.read(read_fd,65536)
   if not chunk:break
   chunks.append(chunk)
  return b"".join(chunks)
 finally:
  if not closed:os.close(write_fd)
  os.close(saved);os.close(read_fd)
def dispatch(payload):
 box=[]
 def call():
  box.append(module._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_BEGIN,payload,module._MODE_V5_READY))
 emitted=captured(call)
 return box[0],emitted
root=tempfile.mkdtemp(prefix="store-v5-quota-",dir=parent)
fds=None
try:
 root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds=module.Fds();fds.add(root_fd)
 root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
 lock_fd,lock_device,lock_inode,lock_error=module._bind_lock(fds,root_fd,uid,root_device)
 if lock_error is not None:raise RuntimeError("lock")
 admitted=[];outstanding=0
 for index in range(9):
  lifecycle=bytearray(32);lifecycle[0]=index;generation=bytearray(range(32,64));generation[31]=index
  genesis=bytes(range(64));identity_digest=module._digest(genesis)
  record=bytearray(module._WAL_SIZE);record[:11]=module._WAL_MAGIC;record[16]=module._W_ALLOCATED;struct.pack_into(">Q",record,24,1);record[32:64]=lifecycle;record[64:96]=generation;record[96:128]=module._ZERO32;record[128:160]=identity_digest
  create_payload=bytes(lifecycle)+bytes(generation)+struct.pack(">I",len(genesis))+genesis+bytes(record)
  module._zero(identity_digest)
  result,create_error=module._cmd_create(fds,root_fd,create_payload,uid,root_device)
  if create_error is not None:raise RuntimeError("create")
  tx=bytearray(32);tx[0]=index+1
  payload=bytearray(172);payload[0:32]=lifecycle;payload[32:64]=generation;payload[64:96]=bytes(range(64,96));payload[96:128]=tx;payload[128:160]=bytes(range(96,128));struct.pack_into(">I",payload,160,17);struct.pack_into(">Q",payload,164,23)
  counts=os.fstatvfs(root_fd);available=counts.f_bavail*counts.f_frsize
  expected_ok=len(admitted)+1<=8 and (len(admitted)+1)*1100000000<=8800000000 and available>=outstanding+1100000000+4294967296
  outcome,emitted=dispatch(payload)
  evidence=os.path.join(root,lifecycle.hex(),"generations",generation.hex(),"workspace-evidence")
  if expected_ok:
   if outcome!=(module._MODE_V5_READY,"emitted",None) or emitted!=frame or not os.path.isdir(evidence):raise RuntimeError("admit-%d"%index)
   admitted.append(bytearray(payload));outstanding+=1100000000-300
  else:
   if outcome!=(module._MODE_V5_READY,"error",module._E_QUOTA) or emitted!=b"" or os.path.exists(evidence):raise RuntimeError("quota-%d"%index)
  module._zero(payload)
 if len(admitted)<1 or len(admitted)>8:raise RuntimeError("count")
 retry=bytearray(admitted[0])
 outcome,emitted=dispatch(retry)
 if outcome!=(module._MODE_V5_READY,"emitted",None) or emitted!=frame:raise RuntimeError("retry")
 module._zero(retry)
 items,reconstructed=module._v5_collect_inventory(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode)
 if len(items)!=len(admitted) or reconstructed!=len(admitted)*(1100000000-300):raise RuntimeError("inventory")
 module._v5_zero_transactions(items)
 for admitted_payload in admitted:
  module._zero(admitted_payload)
 if fds.uncertain or fds.items!=[root_fd,lock_fd]:raise RuntimeError("fds")
finally:
 if fds is not None:fds.close_all()
 shutil.rmtree(root)
print("V5_WS_BEGIN_QUOTA_OK %d"%len(admitted))
`;
		const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
		const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
			cwd: "/",
			env: {},
			timeout: 30_000,
			maxBuffer: 1024,
		});
		expect(stderr).toBe("");
		const match = /^V5_WS_BEGIN_QUOTA_OK ([1-8])\n$/.exec(stdout);
		expect(match).not.toBeNull();
	});

	linuxProbeTest("V5 WS_BEGIN capacity and publication fault arms stay fixed", async () => {
		const probe = `import importlib.util,os,shutil,struct,sys,tempfile
source=open(sys.argv[1]).read()
spec=importlib.util.spec_from_file_location("store_v5_arm_real",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
uid=os.getuid()
parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
frame=struct.pack(">BI",0x80,25)+bytes((0x0A,))+bytes(24)
counter=[0]
def mutated(replacements):
 text=source
 for anchor,replacement in replacements:
  if text.count(anchor)!=1:raise RuntimeError("anchor")
  text=text.replace(anchor,replacement,1)
 counter[0]+=1
 path=os.path.join(parent,"ws-arm-mod-%d.py"%counter[0])
 handle=open(path,"w")
 handle.write(text)
 handle.close()
 try:
  spec2=importlib.util.spec_from_file_location("ws_arm_mod_%d"%counter[0],path)
  loaded=importlib.util.module_from_spec(spec2)
  spec2.loader.exec_module(loaded)
 finally:
  os.unlink(path)
 return loaded
def captured(call):
 read_fd,write_fd=os.pipe();saved=os.dup(1);closed=False
 try:
  os.dup2(write_fd,1)
  try:call()
  finally:os.dup2(saved,1)
  os.close(write_fd);closed=True
  chunks=[]
  while True:
   chunk=os.read(read_fd,65536)
   if not chunk:break
   chunks.append(chunk)
  return b"".join(chunks)
 finally:
  if not closed:os.close(write_fd)
  os.close(saved);os.close(read_fd)
def build(mod,lifecycle,generation):
 root=tempfile.mkdtemp(prefix="store-v5-arm-",dir=parent)
 root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds=mod.Fds();fds.add(root_fd)
 root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
 lock_fd,lock_device,lock_inode,lock_error=mod._bind_lock(fds,root_fd,uid,root_device)
 if lock_error is not None:raise RuntimeError("lock")
 genesis=bytes(range(64));identity_digest=mod._digest(genesis)
 record=bytearray(mod._WAL_SIZE);record[:11]=mod._WAL_MAGIC;record[16]=mod._W_ALLOCATED;struct.pack_into(">Q",record,24,1);record[32:64]=lifecycle;record[64:96]=generation;record[96:128]=mod._ZERO32;record[128:160]=identity_digest
 payload=bytes(lifecycle)+bytes(generation)+struct.pack(">I",len(genesis))+genesis+bytes(record)
 mod._zero(identity_digest)
 result,create_error=mod._cmd_create(fds,root_fd,payload,uid,root_device)
 if create_error is not None:raise RuntimeError("create")
 return root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode
def request(lifecycle,generation,tx_bytes):
 payload=bytearray(172);payload[0:32]=lifecycle;payload[32:64]=generation;payload[64:96]=bytes(range(64,96));payload[96:128]=tx_bytes;payload[128:160]=bytes(range(96,128));struct.pack_into(">I",payload,160,17);struct.pack_into(">Q",payload,164,23)
 return payload
def evidence_path(root,lifecycle,generation):
 return os.path.join(root,lifecycle.hex(),"generations",generation.hex(),"workspace-evidence")
lifecycle=bytearray(range(32));generation=bytearray(range(32,64));tx=bytes((1,))+bytes(31)
# floor below capacity: pre-effect QUOTA with no frame and no mutation, helper keeps answering,
# then the unmutated helper admits the same request after capacity returns
mod=mutated([("_V5_FLOOR_BYTES = 4294967296","_V5_FLOOR_BYTES = 1152921504606846976")])
selector=request(lifecycle,generation,tx)
root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=build(mod,lifecycle,generation)
try:
 def floor_call():
  return mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_BEGIN,selector,mod._MODE_V5_READY)
 box=[]
 emitted=captured(lambda:box.append(floor_call()))
 if box[0]!=(mod._MODE_V5_READY,"error",mod._E_QUOTA) or emitted!=b"" or os.path.exists(evidence_path(root,lifecycle,generation)):raise RuntimeError("floor")
 box.clear()
 emitted=captured(lambda:box.append(floor_call()))
 if box[0]!=(mod._MODE_V5_READY,"error",mod._E_QUOTA) or emitted!=b"":raise RuntimeError("floor-again")
 fds.close_all()
 fds=module.Fds()
 root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds.add(root_fd)
 root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
 lock_fd,lock_device,lock_inode,lock_error=module._bind_lock(fds,root_fd,uid,root_device)
 if lock_error is not None:raise RuntimeError("relock")
 box.clear()
 emitted=captured(lambda:box.append(module._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_BEGIN,selector,module._MODE_V5_READY)))
 if box[0]!=(module._MODE_V5_READY,"emitted",None) or emitted!=frame or not os.path.isdir(evidence_path(root,lifecycle,generation)):raise RuntimeError("floor-recovered")
finally:
 if fds is not None:fds.close_all()
 shutil.rmtree(root)
module._zero(selector)
# statvfs guard arms: zero frsize, negative frsize, oversized frsize, negative available,
# product overflow, and syscall failure are each fatal IO before mutation with no frame
frsize_line="    frsize = counts.f_frsize"
available_line="    available = counts.f_bavail"
statvfs_line="    counts = os.fstatvfs(fd)"
for label,anchor,replacement in (
 ("zero-frsize",frsize_line,"    frsize = 0"),
 ("negative-frsize",frsize_line,"    frsize = -counts.f_frsize"),
 ("oversized-frsize",frsize_line,"    frsize = _V5_U64_MAX + 1"),
 ("negative-available",available_line,"    available = -counts.f_bavail"),
 ("product-overflow",available_line,"    available = _V5_U64_MAX"),
 ("statvfs-syscall-fail",statvfs_line,"    counts = os.fstatvfs(-1)"),
):
 mod=mutated([(anchor,replacement)])
 root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=build(mod,lifecycle,generation)
 try:
  seen=[];box=[]
  def fatal_call():
   try:
    box.append(mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_BEGIN,request(lifecycle,generation,tx),mod._MODE_V5_READY))
   except mod.Fatal as failure:
    seen.append(failure.code)
  emitted=captured(fatal_call)
  if seen!=[mod._E_IO] or emitted!=b"" or os.path.exists(evidence_path(root,lifecycle,generation)):raise RuntimeError(label)
 finally:
  fds.close_all();shutil.rmtree(root)
# global count: second lifecycle refused with no frame and no partial evidence
mod=mutated([("_MAX_V5_ITEMS = 8","_MAX_V5_ITEMS = 1")])
lifecycle_b=bytearray(range(96,128));generation_b=bytearray(range(128,160))
root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=build(mod,lifecycle,generation)
try:
 genesis=bytes(range(64));identity_digest=mod._digest(genesis)
 record=bytearray(mod._WAL_SIZE);record[:11]=mod._WAL_MAGIC;record[16]=mod._W_ALLOCATED;struct.pack_into(">Q",record,24,1);record[32:64]=lifecycle_b;record[64:96]=generation_b;record[96:128]=mod._ZERO32;record[128:160]=identity_digest
 payload=bytes(lifecycle_b)+bytes(generation_b)+struct.pack(">I",len(genesis))+genesis+bytes(record)
 mod._zero(identity_digest)
 result,create_error=mod._cmd_create(fds,root_fd,payload,uid,root_device)
 if create_error is not None:raise RuntimeError("create-b")
 box=[];emitted=captured(lambda:box.append(mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_BEGIN,request(lifecycle,generation,tx),mod._MODE_V5_READY)))
 first=box[0]
 box.clear();emitted2=captured(lambda:box.append(mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_BEGIN,request(lifecycle_b,generation_b,tx),mod._MODE_V5_READY)))
 if first!=(mod._MODE_V5_READY,"emitted",None) or emitted!=frame:raise RuntimeError("count-first")
 if box[0]!=(mod._MODE_V5_READY,"error",mod._E_QUOTA) or emitted2!=b"":raise RuntimeError("count-second")
 if os.path.exists(evidence_path(root,lifecycle_b,generation_b)):raise RuntimeError("count-evidence")
finally:
 fds.close_all();shutil.rmtree(root)
# link EEXIST: same-inode race completes forward with the exact frame, foreign canonical fails closed
link_anchor="            os.link(\\n                manifest_name,\\n                _INPUT_MANIFEST,\\n                src_dir_fd=evidence_fd,\\n                dst_dir_fd=evidence_fd,\\n                follow_symlinks=False,\\n            )"
if source.count(link_anchor)!=1:raise RuntimeError("link-anchor")
mod=mutated([(link_anchor,link_anchor+"\\n"+link_anchor)])
root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=build(mod,lifecycle,generation)
try:
 box=[];emitted=captured(lambda:box.append(mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_BEGIN,request(lifecycle,generation,tx),mod._MODE_V5_READY)))
 evidence=evidence_path(root,lifecycle,generation)
 if box[0]!=(mod._MODE_V5_READY,"emitted",None) or emitted!=frame or len(os.listdir(evidence))!=3 or os.stat(os.path.join(evidence,"input.manifest")).st_nlink!=1:raise RuntimeError("link-same")
finally:
 fds.close_all();shutil.rmtree(root)
foreign="            fdx = os.open(_INPUT_MANIFEST, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=evidence_fd)\\n            os.close(fdx)\\n"
mod=mutated([(link_anchor,foreign+link_anchor)])
root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=build(mod,lifecycle,generation)
try:
 seen=[];box=[]
 def foreign_call():
  try:
   box.append(mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_BEGIN,request(lifecycle,generation,tx),mod._MODE_V5_READY))
  except mod.Fatal as failure:
   seen.append(failure.code)
 emitted=captured(foreign_call)
 if seen!=[mod._E_NLINK] or emitted!=b"":raise RuntimeError("link-foreign")
finally:
 fds.close_all();shutil.rmtree(root)
# close uncertainty: the fatal check after the last pre-frame close fires before the response,
# so the OK frame is never written; recovery preserves the draft and the exact retry returns it
close_pair="        fds.close(lifecycle_fd)\\n        lifecycle_fd = None"
if source.count(close_pair)!=1:raise RuntimeError("close-anchor")
mod=mutated([(close_pair,"        fds.close(lifecycle_fd)\\n        fds.close(lifecycle_fd)\\n        lifecycle_fd = None")])
root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=build(mod,lifecycle,generation)
try:
 seen=[];box=[]
 def uncertain_call():
  try:
   box.append(mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_BEGIN,request(lifecycle,generation,tx),mod._MODE_V5_READY))
  except mod.Fatal as failure:
   seen.append(failure.code)
 emitted=captured(uncertain_call)
 evidence=evidence_path(root,lifecycle,generation)
 if seen!=[mod._E_UNCERTAIN] or emitted!=b"" or len(os.listdir(evidence))!=3:raise RuntimeError("close-uncertain")
 fds.close_all()
 generation_path=os.path.dirname(evidence)
 recover_fds=module.Fds()
 generation_fd=os.open(generation_path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 recover_fds.add(generation_fd)
 try:
  if module._v5_recover_input_begin_prefix(recover_fds,generation_fd,lifecycle,generation,uid,os.fstat(generation_fd).st_dev) is not True:raise RuntimeError("close-recovery")
 finally:
  recover_fds.close(generation_fd)
 fds=module.Fds()
 root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds.add(root_fd)
 root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
 lock_fd,lock_device,lock_inode,lock_error=module._bind_lock(fds,root_fd,uid,root_device)
 if lock_error is not None:raise RuntimeError("close-relock")
 box.clear()
 emitted=captured(lambda:box.append(module._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_BEGIN,request(lifecycle,generation,tx),module._MODE_V5_READY)))
 if box[0]!=(module._MODE_V5_READY,"emitted",None) or emitted!=frame:raise RuntimeError("close-retry")
finally:
 if fds is not None:fds.close_all()
 shutil.rmtree(root)
print("V5_WS_BEGIN_ARMS_OK 11")
`;
		const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
		const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
			cwd: "/",
			env: {},
			timeout: 30_000,
			maxBuffer: 1024,
		});
		expect(stderr).toBe("");
		expect(stdout).toBe("V5_WS_BEGIN_ARMS_OK 11\n");
	});

	linuxProbeTest("V5 WS_BEGIN crash cuts stay recovery-classified for every publication state", async () => {
		const probe = `import importlib.util,os,shutil,struct,sys,tempfile
source=open(sys.argv[1]).read()
spec=importlib.util.spec_from_file_location("store_v5_cut_real",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
uid=os.getuid()
parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
frame=struct.pack(">BI",0x80,25)+bytes((0x0A,))+bytes(24)
cuts=[
 ("B00",
  '        evidence_fd, created = _make_dir(fds, generation_fd, _WORKSPACE_EVIDENCE, uid, device)',
  '        raise Fatal(_E_IO)',
  "false"),
 ("B01",
  '        evidence_fd, created = _make_dir(fds, generation_fd, _WORKSPACE_EVIDENCE, uid, device)',
  '        os.mkdir(_WORKSPACE_EVIDENCE, 0o700, dir_fd=generation_fd)\\n        evidence_fd, opened_error = _open_dir(fds, generation_fd, _WORKSPACE_EVIDENCE, uid, device)\\n        if evidence_fd is None:\\n            raise Fatal(_E_UNCERTAIN)\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B02",
  '        evidence_fd, created = _make_dir(fds, generation_fd, _WORKSPACE_EVIDENCE, uid, device)',
  '        os.mkdir(_WORKSPACE_EVIDENCE, 0o700, dir_fd=generation_fd)\\n        evidence_fd, opened_error = _open_dir(fds, generation_fd, _WORKSPACE_EVIDENCE, uid, device)\\n        if evidence_fd is None:\\n            raise Fatal(_E_UNCERTAIN)\\n        _fsync(generation_fd)\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B03",
  '        plan_fd, plan_name, plan_suffix = _v5_create_nonce_file(\\n            fds, evidence_fd, _PLAN_DRAFT_PREFIX, [], uid, device\\n        )',
  '        plan_fd, plan_name, plan_suffix = _v5_create_nonce_file(\\n            fds, evidence_fd, _PLAN_DRAFT_PREFIX, [], uid, device\\n        )\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B04",
  '        _v5_write_prefix(plan_fd, plan_header)',
  '        _v5_write_prefix(plan_fd, plan_header[:5])\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B05",
  '        _fdatasync(plan_fd)',
  '        _fdatasync(plan_fd)\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B06",
  '        _fdatasync(plan_fd)\\n        _fsync(evidence_fd)',
  '        _fdatasync(plan_fd)\\n        _fsync(evidence_fd)\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B07",
  '        content_fd, content_name, content_suffix = _v5_create_nonce_file(\\n            fds, evidence_fd, _CONTENT_DRAFT_PREFIX, [plan_name], uid, device\\n        )',
  '        content_fd, content_name, content_suffix = _v5_create_nonce_file(\\n            fds, evidence_fd, _CONTENT_DRAFT_PREFIX, [plan_name], uid, device\\n        )\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B08",
  '        _v5_write_prefix(content_fd, content_header)',
  '        _v5_write_prefix(content_fd, content_header[:9])\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B09",
  '        _fdatasync(content_fd)',
  '        _fdatasync(content_fd)\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B10",
  '        _fdatasync(content_fd)\\n        _fsync(evidence_fd)',
  '        _fdatasync(content_fd)\\n        _fsync(evidence_fd)\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B11",
  '        manifest_fd, manifest_name, manifest_suffix = _v5_create_nonce_file(\\n            fds, evidence_fd, _INPUT_MANIFEST_TEMP_PREFIX, [content_name, plan_name], uid, device\\n        )',
  '        manifest_fd, manifest_name, manifest_suffix = _v5_create_nonce_file(\\n            fds, evidence_fd, _INPUT_MANIFEST_TEMP_PREFIX, [content_name, plan_name], uid, device\\n        )\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B12",
  '        _v5_write_prefix(manifest_fd, manifest)',
  '        _v5_write_prefix(manifest_fd, manifest[:137])\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B13",
  '        _fdatasync(manifest_fd)',
  '        _fdatasync(manifest_fd)\\n        raise Fatal(_E_IO)',
  "absent"),
 ("B14",
  '        destination_fd, destination_error = _open_file(',
  '        raise Fatal(_E_IO)\\n        destination_fd, destination_error = _open_file(',
  "present3"),
 ("B15",
  '        destination_stat = _fstat(destination_fd)',
  '        raise Fatal(_E_IO)\\n        destination_stat = _fstat(destination_fd)',
  "present3"),
 ("B16",
  '        if not _v5_same_inode(destination_stat, manifest_stat):\\n            raise Fatal(_E_STATE)\\n        _fsync(evidence_fd)',
  '        if not _v5_same_inode(destination_stat, manifest_stat):\\n            raise Fatal(_E_STATE)\\n        raise Fatal(_E_IO)\\n        _fsync(evidence_fd)',
  "present3"),
 ("B17",
  '        _fsync(evidence_fd)\\n        _unlink(evidence_fd, manifest_name)',
  '        _fsync(evidence_fd)\\n        raise Fatal(_E_IO)\\n        _unlink(evidence_fd, manifest_name)',
  "present3"),
 ("B18",
  '        _unlink(evidence_fd, manifest_name)\\n        _fsync(evidence_fd)',
  '        _unlink(evidence_fd, manifest_name)\\n        raise Fatal(_E_IO)\\n        _fsync(evidence_fd)',
  "present3"),
 ("B19",
  '        _v5_require_absent(evidence_fd, manifest_name)\\n        fds.close(manifest_fd)',
  '        _v5_require_absent(evidence_fd, manifest_name)\\n        raise Fatal(_E_IO)\\n        fds.close(manifest_fd)',
  "present3"),
 ("B20",
  '        final_stat = _v5_validate_retained_file(destination_fd, destination_stat, uid, device, 1)',
  '        final_stat = _v5_validate_retained_file(destination_fd, destination_stat, uid, device, 1)\\n        raise Fatal(_E_IO)',
  "present3"),
 ("B21",
  '        _v5_validate_named_file(evidence_fd, _INPUT_MANIFEST, final_stat, uid, device, 1)',
  '        _v5_validate_named_file(evidence_fd, _INPUT_MANIFEST, final_stat, uid, device, 1)\\n        raise Fatal(_E_IO)',
  "present3"),
]
counter=[0]
def mutated(anchor,replacement):
 if source.count(anchor)!=1:raise RuntimeError("anchor")
 text=source.replace(anchor,replacement,1)
 counter[0]+=1
 path=os.path.join(parent,"ws-cut-mod-%d.py"%counter[0])
 handle=open(path,"w")
 handle.write(text)
 handle.close()
 try:
  spec2=importlib.util.spec_from_file_location("ws_cut_mod_%d"%counter[0],path)
  loaded=importlib.util.module_from_spec(spec2)
  spec2.loader.exec_module(loaded)
 finally:
  os.unlink(path)
 return loaded
def captured(call):
 read_fd,write_fd=os.pipe();saved=os.dup(1);closed=False
 try:
  os.dup2(write_fd,1)
  try:call()
  finally:os.dup2(saved,1)
  os.close(write_fd);closed=True
  chunks=[]
  while True:
   chunk=os.read(read_fd,65536)
   if not chunk:break
   chunks.append(chunk)
  return b"".join(chunks)
 finally:
  if not closed:os.close(write_fd)
  os.close(saved);os.close(read_fd)
def build(mod):
 root=tempfile.mkdtemp(prefix="store-v5-cut-",dir=parent)
 fds=None
 try:
  root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds=mod.Fds();fds.add(root_fd)
  root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
  lock_fd,lock_device,lock_inode,lock_error=mod._bind_lock(fds,root_fd,uid,root_device)
  if lock_error is not None:raise RuntimeError("lock")
  lifecycle=bytearray(range(32));generation=bytearray(range(32,64))
  genesis=bytes(range(64));identity_digest=mod._digest(genesis)
  record=bytearray(mod._WAL_SIZE);record[:11]=mod._WAL_MAGIC;record[16]=mod._W_ALLOCATED;struct.pack_into(">Q",record,24,1);record[32:64]=lifecycle;record[64:96]=generation;record[96:128]=mod._ZERO32;record[128:160]=identity_digest
  payload=bytes(lifecycle)+bytes(generation)+struct.pack(">I",len(genesis))+genesis+bytes(record)
  mod._zero(identity_digest)
  result,create_error=mod._cmd_create(fds,root_fd,payload,uid,root_device)
  if create_error is not None:raise RuntimeError("create")
  request=bytearray(172);request[0:32]=lifecycle;request[32:64]=generation;request[64:96]=bytes(range(64,96));request[96:128]=bytes((1,))+bytes(31);request[128:160]=bytes(range(96,128));struct.pack_into(">I",request,160,17);struct.pack_into(">Q",request,164,23)
  return root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,lifecycle,generation,request
 except BaseException:
  if fds is not None:fds.close_all()
  shutil.rmtree(root)
  raise
def rebind(root):
 fds=module.Fds()
 root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds.add(root_fd)
 root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
 lock_fd,lock_device,lock_inode,lock_error=module._bind_lock(fds,root_fd,uid,root_device)
 if lock_error is not None:raise RuntimeError("relock")
 return fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode
for label,anchor,replacement,expected in cuts:
 root=None;request=None
 try:
  mod=mutated(anchor,replacement)
  root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode,lifecycle,generation,request=build(mod)
  try:
   seen=[];box=[]
   def cut_call():
    try:
     box.append(mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_BEGIN,request,mod._MODE_V5_READY))
    except mod.Fatal as failure:
     seen.append(failure.code)
   emitted=captured(cut_call)
   if seen!=[mod._E_IO] or emitted!=b"":raise RuntimeError(label)
  finally:
   fds.close_all()
  generation_path=os.path.join(root,lifecycle.hex(),"generations",generation.hex())
  evidence_path=os.path.join(generation_path,"workspace-evidence")
  recover_fds=module.Fds()
  generation_fd=os.open(generation_path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  recover_fds.add(generation_fd)
  try:
   recovered=module._v5_recover_input_begin_prefix(recover_fds,generation_fd,lifecycle,generation,uid,os.fstat(generation_fd).st_dev)
  finally:
   recover_fds.close(generation_fd)
  present=os.path.isdir(evidence_path)
  if expected=="false":
   if recovered is not False or present:raise RuntimeError(label)
  elif expected=="absent":
   if recovered is not True or present:raise RuntimeError(label)
  else:
   if recovered is not True or not present or len(os.listdir(evidence_path))!=3:raise RuntimeError(label)
  fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=rebind(root)
  try:
   box=[]
   emitted=captured(lambda:box.append(module._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,module._WS_BEGIN,request,module._MODE_V5_READY)))
   if box[0]!=(module._MODE_V5_READY,"emitted",None) or emitted!=frame:raise RuntimeError(label+"-after")
   items,outstanding=module._v5_collect_inventory(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode)
   if len(items)!=1 or outstanding!=1100000000-300:raise RuntimeError(label+"-inventory")
   module._v5_zero_transactions(items)
  finally:
   fds.close_all()
 finally:
  if root is not None:shutil.rmtree(root)
  if request is not None:module._zero(request)
print("V5_WS_BEGIN_CUTS_OK 22")
`;
		const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
		const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
			cwd: "/",
			env: {},
			timeout: 60_000,
			maxBuffer: 1024,
		});
		expect(stderr).toBe("");
		expect(stdout).toBe("V5_WS_BEGIN_CUTS_OK 22\n");
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
