import { createAnsiCodeExtractor, visibleWidth } from "./utils.js";

const TABLE_MARKER_PREFIX = "\x1b_pi:table:";
const TABLE_START_MARKER = `${TABLE_MARKER_PREFIX}start\x07`;
const TABLE_END_MARKER = `${TABLE_MARKER_PREFIX}end\x07`;

export interface TableCellSelectionRegion {
	line: number;
	col: number;
	width: number;
	table: object;
	tableTop: number;
	tableBottom: number;
	tableLeft: number;
	tableRight: number;
	row: number;
	column: number;
	segment: number;
	content: string;
}

interface CellMarker {
	kind: "cell-start" | "cell-end";
	row: number;
	column: number;
	segment: number;
	content?: string;
}

interface TableBounds {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

function cellMarker(kind: CellMarker["kind"], row: number, column: number, segment: number, content?: string): string {
	const encodedContent = content === undefined ? "" : `:${encodeURIComponent(content)}`;
	return `${TABLE_MARKER_PREFIX}${kind}:${row}:${column}:${segment}${encodedContent}\x07`;
}

function parseCellMarker(code: string): CellMarker | null {
	if (!code.startsWith(TABLE_MARKER_PREFIX) || !code.endsWith("\x07")) return null;
	const [kind, rowText, columnText, segmentText, encodedContent] = code
		.slice(TABLE_MARKER_PREFIX.length, -1)
		.split(":");
	if (kind !== "cell-start" && kind !== "cell-end") return null;
	const row = Number(rowText);
	const column = Number(columnText);
	const segment = Number(segmentText);
	if (![row, column, segment].every(Number.isInteger)) return null;
	return {
		kind,
		row,
		column,
		segment,
		content: encodedContent === undefined ? undefined : decodeURIComponent(encodedContent),
	};
}

export function markTableStart(line: string): string {
	return TABLE_START_MARKER + line;
}

export function markTableEnd(line: string): string {
	return line + TABLE_END_MARKER;
}

export function markTableCell(text: string, row: number, column: number, segment: number, content: string): string {
	const markerContent = segment === 0 ? content : undefined;
	return (
		cellMarker("cell-start", row, column, segment, markerContent) +
		text +
		cellMarker("cell-end", row, column, segment)
	);
}

export function extractTableCellSelectionRegions(
	lines: string[],
	getTableIdentity: (index: number) => object,
): { lines: string[]; regions: TableCellSelectionRegion[] } {
	if (!lines.some((line) => line.includes(TABLE_MARKER_PREFIX))) {
		return { lines, regions: [] };
	}

	const cleanLines: string[] = [];
	const regions: TableCellSelectionRegion[] = [];
	const cellContents = new Map<object, Map<string, string>>();
	const tableBounds = new Map<object, TableBounds>();
	let table: object | null = null;
	let tableIndex = 0;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const source = lines[lineIndex];
		if (!source.includes(TABLE_MARKER_PREFIX)) {
			cleanLines.push(source);
			continue;
		}
		let clean = "";
		let activeCell: (CellMarker & { col: number }) | null = null;
		let offset = 0;
		const extractAnsi = createAnsiCodeExtractor(source);

		while (offset < source.length) {
			const ansi = extractAnsi(offset);
			if (!ansi) {
				clean += source[offset];
				offset++;
				continue;
			}

			if (ansi.code === TABLE_START_MARKER) {
				table = getTableIdentity(tableIndex++);
				const col = visibleWidth(clean);
				tableBounds.set(table, { top: lineIndex, bottom: lineIndex, left: col, right: col });
			} else if (ansi.code === TABLE_END_MARKER) {
				if (table) {
					const bounds = tableBounds.get(table);
					if (bounds) {
						bounds.bottom = lineIndex;
						bounds.right = visibleWidth(clean);
					}
				}
				table = null;
				activeCell = null;
			} else {
				const marker = parseCellMarker(ansi.code);
				if (marker?.kind === "cell-start") {
					activeCell = { ...marker, col: visibleWidth(clean) };
					if (table && marker.content !== undefined) {
						let tableContents = cellContents.get(table);
						if (!tableContents) {
							tableContents = new Map();
							cellContents.set(table, tableContents);
						}
						tableContents.set(`${marker.row}:${marker.column}`, marker.content);
					}
				} else if (marker?.kind === "cell-end" && table && activeCell) {
					const width = visibleWidth(clean) - activeCell.col;
					if (
						width > 0 &&
						marker.row === activeCell.row &&
						marker.column === activeCell.column &&
						marker.segment === activeCell.segment
					) {
						regions.push({
							line: lineIndex,
							col: activeCell.col,
							width,
							table,
							tableTop: 0,
							tableBottom: 0,
							tableLeft: 0,
							tableRight: 0,
							row: marker.row,
							column: marker.column,
							segment: marker.segment,
							content: "",
						});
					}
					activeCell = null;
				} else {
					clean += ansi.code;
				}
			}
			offset += ansi.length;
		}
		cleanLines.push(clean);
	}
	for (const region of regions) {
		const bounds = tableBounds.get(region.table);
		if (bounds) {
			region.tableTop = bounds.top;
			region.tableBottom = bounds.bottom;
			region.tableLeft = bounds.left;
			region.tableRight = bounds.right;
		}
		region.content = cellContents.get(region.table)?.get(`${region.row}:${region.column}`) ?? "";
	}

	return { lines: cleanLines, regions };
}
