/**
 * Strict private decoder for Prime CLI 0.6.21 sandbox list/get JSON.
 * Supporting another CLI version requires new source hashes, fixtures, and review.
 */

const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_FIELD_BYTES = 512;
const MAX_ROWS = 100;
const MAX_COLLECTION_ITEMS = 100;
const MAX_PAGE_NUMBER = 1_000_000;
const MAX_RESOURCE_NUMBER = 1_000_000_000;
const MAX_TIMEOUT_MINUTES = 1_000_000;
const MISSING = Symbol("missing-own-data-property");

type Missing = typeof MISSING;
export type PrimeSandboxStatus = "PENDING" | "PROVISIONING" | "RUNNING" | "PAUSED" | "ERROR" | "TERMINATED" | "TIMEOUT";

export type PrimeCliJsonFailureCode = "INPUT_INVALID" | "INVALID_OUTPUT";
export type PrimeCliJsonFailure = Readonly<{ ok: false; code: PrimeCliJsonFailureCode }>;

export type PrimeSandboxListRow = Readonly<{
	id: string;
	status: PrimeSandboxStatus;
	labels: readonly string[];
}>;

export type PrimeSandboxListPage = Readonly<{
	sandboxes: readonly PrimeSandboxListRow[];
	total: number;
	page: number;
	perPage: number;
	hasNext: boolean;
}>;

export type PrimeSandboxListResult = Readonly<{ ok: true; value: PrimeSandboxListPage }> | PrimeCliJsonFailure;

export type PrimeSandboxDetail = Readonly<{
	id: string;
	status: PrimeSandboxStatus;
	labels: readonly string[];
	vm: boolean;
	type: "VM" | "Container";
}>;

export type PrimeSandboxGetResult = Readonly<{ ok: true; value: PrimeSandboxDetail }> | PrimeCliJsonFailure;

function failure(code: PrimeCliJsonFailureCode): PrimeCliJsonFailure {
	return Object.freeze({ ok: false, code });
}

function ownData(object: object, key: string): unknown | Missing {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return MISSING;
	const value: unknown = descriptor.value;
	return value;
}

function isPlainObject(value: unknown): value is object {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function boundedUtf8(value: string, maximumBytes: number, allowEmpty: boolean): boolean {
	if (!allowEmpty && value.length === 0) return false;
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

function controlFree(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f) return false;
	}
	return true;
}

function boundedString(value: unknown, allowEmpty = true): value is string {
	return typeof value === "string" && boundedUtf8(value, MAX_FIELD_BYTES, allowEmpty) && controlFree(value);
}

function validSandboxId(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 4 || value.length > 128) return false;
	if (value[0] !== "s" || value[1] !== "b" || value[2] !== "_") return false;
	for (let index = 3; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		const hexadecimal =
			(unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x46) || (unit >= 0x61 && unit <= 0x66);
		if (!hexadecimal) return false;
	}
	return true;
}

function validStatus(value: unknown): value is PrimeSandboxStatus {
	return (
		value === "PENDING" ||
		value === "PROVISIONING" ||
		value === "RUNNING" ||
		value === "PAUSED" ||
		value === "ERROR" ||
		value === "TERMINATED" ||
		value === "TIMEOUT"
	);
}

function digit(value: string, index: number): number | undefined {
	const unit = value.charCodeAt(index);
	if (unit < 0x30 || unit > 0x39) return undefined;
	return unit - 0x30;
}

function twoDigits(value: string, index: number): number | undefined {
	const first = digit(value, index);
	const second = digit(value, index + 1);
	if (first === undefined || second === undefined) return undefined;
	return first * 10 + second;
}

function fourDigits(value: string): number | undefined {
	const first = twoDigits(value, 0);
	const second = twoDigits(value, 2);
	if (first === undefined || second === undefined) return undefined;
	return first * 100 + second;
}

function validPrimeTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length !== 23) return false;
	if (
		value[4] !== "-" ||
		value[7] !== "-" ||
		value[10] !== " " ||
		value[13] !== ":" ||
		value[16] !== ":" ||
		value.slice(19) !== " UTC"
	) {
		return false;
	}
	const year = fourDigits(value);
	const month = twoDigits(value, 5);
	const day = twoDigits(value, 8);
	const hour = twoDigits(value, 11);
	const minute = twoDigits(value, 14);
	const second = twoDigits(value, 17);
	if (
		year === undefined ||
		month === undefined ||
		day === undefined ||
		hour === undefined ||
		minute === undefined ||
		second === undefined ||
		year < 1 ||
		month < 1 ||
		month > 12 ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		return false;
	}
	let maximumDay = 31;
	if (month === 4 || month === 6 || month === 9 || month === 11) maximumDay = 30;
	if (month === 2) {
		const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
		maximumDay = leap ? 29 : 28;
	}
	return day >= 1 && day <= maximumDay;
}

function finiteInteger(value: unknown, minimum: number, maximum: number): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		Number.isSafeInteger(value) &&
		value >= minimum &&
		value <= maximum
	);
}

function finiteNumber(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function stringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_COLLECTION_ITEMS) return undefined;
	const output: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const item = ownData(value, String(index));
		if (!boundedString(item)) return undefined;
		output.push(item);
	}
	return Object.freeze(output);
}

function nullableString(value: unknown): boolean {
	return value === null || boundedString(value);
}

function nullableTimestamp(value: unknown): boolean {
	return value === null || validPrimeTimestamp(value);
}

function nullableInteger(value: unknown, minimum: number, maximum: number): boolean {
	return value === null || finiteInteger(value, minimum, maximum);
}

function optionalValue(object: object, key: string): unknown | Missing {
	return ownData(object, key);
}

function validateOptionalTimestamp(object: object, key: string): boolean {
	const value = optionalValue(object, key);
	return value === MISSING || validPrimeTimestamp(value);
}

function validateOptionalExitCode(object: object): boolean {
	const value = optionalValue(object, "exit_code");
	return value === MISSING || finiteInteger(value, -2_147_483_648, 2_147_483_647);
}

function validateStringMap(value: unknown): boolean {
	if (!isPlainObject(value)) return false;
	const keys = Object.keys(value);
	if (keys.length > MAX_COLLECTION_ITEMS) return false;
	for (const key of keys) {
		if (!boundedUtf8(key, MAX_FIELD_BYTES, true)) return false;
		const item = ownData(value, key);
		if (!boundedString(item)) return false;
	}
	return true;
}

function validateJsonValue(value: unknown, depth: number): boolean {
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "string") return boundedUtf8(value, MAX_FIELD_BYTES, true);
	if (typeof value === "number") return Number.isFinite(value);
	if (depth >= 4) return false;
	if (Array.isArray(value)) {
		if (value.length > MAX_COLLECTION_ITEMS) return false;
		for (let index = 0; index < value.length; index++) {
			if (!validateJsonValue(ownData(value, String(index)), depth + 1)) return false;
		}
		return true;
	}
	if (!isPlainObject(value)) return false;
	const keys = Object.keys(value);
	if (keys.length > MAX_COLLECTION_ITEMS) return false;
	for (const key of keys) {
		if (!boundedUtf8(key, MAX_FIELD_BYTES, true)) return false;
		if (!validateJsonValue(ownData(value, key), depth + 1)) return false;
	}
	return true;
}

function validateOptionalObject(object: object, key: string, advanced: boolean): boolean {
	const value = optionalValue(object, key);
	if (value === MISSING) return true;
	return advanced ? validateJsonValue(value, 0) && isPlainObject(value) : validateStringMap(value);
}

function parseJsonObject(stdout: string): object | undefined {
	if (!boundedUtf8(stdout, MAX_OUTPUT_BYTES, false)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	return isPlainObject(parsed) ? parsed : undefined;
}

function decodeListRow(value: unknown, expectedLabel: string): PrimeSandboxListRow | undefined {
	if (!isPlainObject(value)) return undefined;
	const id = ownData(value, "id");
	const name = ownData(value, "name");
	const image = ownData(value, "image");
	const status = ownData(value, "status");
	const resources = ownData(value, "resources");
	const region = ownData(value, "region");
	const labelsValue = ownData(value, "labels");
	const createdAt = ownData(value, "created_at");
	const timeoutMinutes = ownData(value, "timeout_minutes");
	const expiresAt = ownData(value, "expires_at");
	if (
		!validSandboxId(id) ||
		!boundedString(name) ||
		!boundedString(image, false) ||
		!validStatus(status) ||
		!boundedString(resources, false) ||
		!nullableString(region) ||
		!validPrimeTimestamp(createdAt) ||
		!finiteInteger(timeoutMinutes, 1, MAX_TIMEOUT_MINUTES) ||
		!nullableTimestamp(expiresAt)
	) {
		return undefined;
	}
	const labels = stringArray(labelsValue);
	if (labels === undefined || !labels.includes(expectedLabel)) return undefined;
	return Object.freeze({ id, status, labels });
}

export function parsePrimeSandboxListOutput(stdout: string, expectedLabel: string): PrimeSandboxListResult {
	if (!boundedUtf8(expectedLabel, MAX_FIELD_BYTES, false) || !controlFree(expectedLabel)) {
		return failure("INPUT_INVALID");
	}
	const object = parseJsonObject(stdout);
	if (object === undefined) return failure("INVALID_OUTPUT");
	const sandboxesValue = ownData(object, "sandboxes");
	const total = ownData(object, "total");
	const page = ownData(object, "page");
	const perPage = ownData(object, "per_page");
	const hasNext = ownData(object, "has_next");
	if (
		!Array.isArray(sandboxesValue) ||
		sandboxesValue.length > MAX_ROWS ||
		!finiteInteger(total, 0, MAX_PAGE_NUMBER) ||
		!finiteInteger(page, 1, MAX_PAGE_NUMBER) ||
		!finiteInteger(perPage, 1, MAX_ROWS) ||
		typeof hasNext !== "boolean" ||
		sandboxesValue.length > perPage ||
		sandboxesValue.length > total ||
		(hasNext ? page * perPage >= total : page * perPage < total)
	) {
		return failure("INVALID_OUTPUT");
	}
	const rows: PrimeSandboxListRow[] = [];
	for (let index = 0; index < sandboxesValue.length; index++) {
		const row = decodeListRow(ownData(sandboxesValue, String(index)), expectedLabel);
		if (row === undefined) return failure("INVALID_OUTPUT");
		for (const prior of rows) {
			if (prior.id === row.id) return failure("INVALID_OUTPUT");
		}
		rows.push(row);
	}
	const value: PrimeSandboxListPage = Object.freeze({
		sandboxes: Object.freeze(rows),
		total,
		page,
		perPage,
		hasNext,
	});
	return Object.freeze({ ok: true, value });
}

function validateRequiredDetailFields(object: object): boolean {
	const name = ownData(object, "name");
	const dockerImage = ownData(object, "docker_image");
	const startCommand = ownData(object, "start_command");
	const cpuCores = ownData(object, "cpu_cores");
	const memoryGb = ownData(object, "memory_gb");
	const diskSizeGb = ownData(object, "disk_size_gb");
	const diskMountPath = ownData(object, "disk_mount_path");
	const gpuCount = ownData(object, "gpu_count");
	const gpuType = ownData(object, "gpu_type");
	const networkAllowlist = ownData(object, "network_allowlist");
	const networkDenylist = ownData(object, "network_denylist");
	const timeoutMinutes = ownData(object, "timeout_minutes");
	const idleTimeoutMinutes = ownData(object, "idle_timeout_minutes");
	const terminationReason = ownData(object, "termination_reason");
	const createdAt = ownData(object, "created_at");
	const userId = ownData(object, "user_id");
	const teamId = ownData(object, "team_id");
	const region = ownData(object, "region");
	const registryCredentialsId = ownData(object, "registry_credentials_id");
	return (
		boundedString(name) &&
		boundedString(dockerImage, false) &&
		(startCommand === null || boundedString(startCommand)) &&
		finiteNumber(cpuCores, 0, MAX_RESOURCE_NUMBER) &&
		finiteNumber(memoryGb, 0, MAX_RESOURCE_NUMBER) &&
		finiteNumber(diskSizeGb, 0, MAX_RESOURCE_NUMBER) &&
		boundedString(diskMountPath, false) &&
		finiteInteger(gpuCount, 0, 1024) &&
		nullableString(gpuType) &&
		(networkAllowlist === null || stringArray(networkAllowlist) !== undefined) &&
		(networkDenylist === null || stringArray(networkDenylist) !== undefined) &&
		finiteInteger(timeoutMinutes, 1, MAX_TIMEOUT_MINUTES) &&
		nullableInteger(idleTimeoutMinutes, 1, MAX_TIMEOUT_MINUTES) &&
		nullableString(terminationReason) &&
		validPrimeTimestamp(createdAt) &&
		nullableString(userId) &&
		nullableString(teamId) &&
		nullableString(region) &&
		nullableString(registryCredentialsId)
	);
}

export function parsePrimeSandboxGetOutput(
	stdout: string,
	expectedId: string,
	expectedLabel: string,
): PrimeSandboxGetResult {
	if (
		!validSandboxId(expectedId) ||
		!boundedUtf8(expectedLabel, MAX_FIELD_BYTES, false) ||
		!controlFree(expectedLabel)
	) {
		return failure("INPUT_INVALID");
	}
	const object = parseJsonObject(stdout);
	if (object === undefined) return failure("INVALID_OUTPUT");
	const id = ownData(object, "id");
	const status = ownData(object, "status");
	const labelsValue = ownData(object, "labels");
	const vm = ownData(object, "vm");
	const type = ownData(object, "type");
	if (
		!validSandboxId(id) ||
		id !== expectedId ||
		!validStatus(status) ||
		typeof vm !== "boolean" ||
		(type !== "VM" && type !== "Container") ||
		(vm ? type !== "VM" : type !== "Container") ||
		!validateRequiredDetailFields(object) ||
		!validateOptionalTimestamp(object, "started_at") ||
		!validateOptionalTimestamp(object, "terminated_at") ||
		!validateOptionalExitCode(object) ||
		!validateOptionalObject(object, "environment_vars", false) ||
		!validateOptionalObject(object, "secrets", false) ||
		!validateOptionalObject(object, "advanced_configs", true)
	) {
		return failure("INVALID_OUTPUT");
	}
	const labels = stringArray(labelsValue);
	if (labels === undefined || !labels.includes(expectedLabel)) return failure("INVALID_OUTPUT");
	const value: PrimeSandboxDetail = Object.freeze({ id, status, labels, vm, type });
	return Object.freeze({ ok: true, value });
}
