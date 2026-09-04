/**
 * Private codec for the exact Prime CLI 0.6.21 version and create output.
 * Callers must pass the version gate before any lifecycle command. Supporting a
 * different version requires new source hashes, fixtures, and codec review.
 */

const PRIME_CLI_VERSION_OUTPUT = "Prime CLI version: 0.6.21\n";
const MAX_CREATE_OUTPUT_BYTES = 1_048_576;
const MAX_SANDBOX_ID_BYTES = 128;
const SANDBOX_ID_PREFIX = "sb_";

export type PrimeCliCodecFailure = Readonly<{
	ok: false;
	code: "INVALID_OUTPUT";
}>;

export type PrimeCliVersion = Readonly<{
	version: "0.6.21";
}>;

export type PrimeCliSandboxIdentity = Readonly<{
	id: string;
}>;

export type PrimeCliVersionResult = Readonly<{ ok: true; value: PrimeCliVersion }> | PrimeCliCodecFailure;

export type PrimeCliCreateResult = Readonly<{ ok: true; value: PrimeCliSandboxIdentity }> | PrimeCliCodecFailure;

function invalidOutput(): PrimeCliCodecFailure {
	return Object.freeze({ ok: false, code: "INVALID_OUTPUT" });
}

function boundedUtf8(value: string, maximumBytes: number): boolean {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x7f) {
			bytes += 1;
		} else if (unit <= 0x7ff) {
			bytes += 2;
		} else if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			bytes += 4;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		} else {
			bytes += 3;
		}
		if (bytes > maximumBytes) return false;
	}
	return true;
}

function isTokenBoundary(unit: number): boolean {
	return (
		unit === 0x09 ||
		unit === 0x0a ||
		unit === 0x0d ||
		unit === 0x20 ||
		unit === 0x22 ||
		unit === 0x27 ||
		unit === 0x28 ||
		unit === 0x29 ||
		unit === 0x2c ||
		unit === 0x3a ||
		unit === 0x3b ||
		unit === 0x5b ||
		unit === 0x5d ||
		unit === 0x7b ||
		unit === 0x7d
	);
}

function isHexadecimal(unit: number): boolean {
	return (unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x46) || (unit >= 0x61 && unit <= 0x66);
}

function createSuccess(id: string): PrimeCliCreateResult {
	const value: PrimeCliSandboxIdentity = Object.freeze({ id });
	return Object.freeze({ ok: true, value });
}

export function parsePrimeCliVersionOutput(stdout: string): PrimeCliVersionResult {
	if (stdout !== PRIME_CLI_VERSION_OUTPUT) return invalidOutput();
	const value: PrimeCliVersion = Object.freeze({ version: "0.6.21" });
	return Object.freeze({ ok: true, value });
}

export function parsePrimeCliCreateOutput(stdout: string): PrimeCliCreateResult {
	if (!boundedUtf8(stdout, MAX_CREATE_OUTPUT_BYTES)) return invalidOutput();

	let foundId: string | undefined;
	let searchFrom = 0;
	while (searchFrom < stdout.length) {
		const start = stdout.indexOf(SANDBOX_ID_PREFIX, searchFrom);
		if (start < 0) break;
		if (start > 0 && !isTokenBoundary(stdout.charCodeAt(start - 1))) return invalidOutput();

		let end = start + SANDBOX_ID_PREFIX.length;
		const hexadecimalStart = end;
		while (end < stdout.length && isHexadecimal(stdout.charCodeAt(end))) end++;
		if (end === hexadecimalStart) return invalidOutput();
		if (end < stdout.length && !isTokenBoundary(stdout.charCodeAt(end))) return invalidOutput();

		const id = stdout.slice(start, end);
		if (!boundedUtf8(id, MAX_SANDBOX_ID_BYTES)) return invalidOutput();
		if (foundId === undefined) {
			foundId = id;
		} else if (foundId !== id) {
			return invalidOutput();
		}
		searchFrom = end;
	}

	if (foundId === undefined) return invalidOutput();
	const successLine = `Successfully created sandbox ${foundId}`;
	let successCount = 0;
	for (const line of stdout.split("\n")) {
		if (line === successLine) successCount++;
	}
	if (successCount !== 1) return invalidOutput();
	return createSuccess(foundId);
}
