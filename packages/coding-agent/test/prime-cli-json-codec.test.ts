import { describe, expect, it } from "bun:test";
import {
	parsePrimeSandboxGetOutput,
	parsePrimeSandboxListOutput,
} from "../src/modes/daemon/sandbox/prime-cli-json-codec.js";
import fixture from "./fixtures/prime-cli-0.6.21-sandbox-json-fixture.json";

function expectFailure(result: unknown, code: "INPUT_INVALID" | "INVALID_OUTPUT" = "INVALID_OUTPUT"): void {
	expect(result).toEqual({ ok: false, code });
	expect(Object.isFrozen(result)).toBe(true);
	if (typeof result === "object" && result !== null) expect(Object.keys(result)).toEqual(["ok", "code"]);
}

function listOutput(value: unknown = fixture.list): string {
	return JSON.stringify(value);
}

function getOutput(value: unknown = fixture.get): string {
	return JSON.stringify(value);
}

function mutateListRow(key: string, value: unknown): string {
	const list = structuredClone(fixture.list);
	Object.defineProperty(list.sandboxes[0], key, { value, enumerable: true, configurable: true, writable: true });
	return listOutput(list);
}

function withoutGetKey(key: string): string {
	const value = structuredClone(fixture.get);
	Reflect.deleteProperty(value, key);
	return getOutput(value);
}

describe("Prime CLI 0.6.21 list JSON codec", () => {
	it("accepts the source-derived fixture and freezes exact retained state", () => {
		const result = parsePrimeSandboxListOutput(listOutput(), fixture.expectedLabel);
		expect(result).toEqual({
			ok: true,
			value: {
				sandboxes: [{ id: "sb_abc123", status: "RUNNING", labels: [fixture.expectedLabel] }],
				total: 1,
				page: 1,
				perPage: 100,
				hasNext: false,
			},
		});
		expect(Object.isFrozen(result)).toBe(true);
		if (result.ok) {
			expect(Object.isFrozen(result.value)).toBe(true);
			expect(Object.isFrozen(result.value.sandboxes)).toBe(true);
			expect(Object.isFrozen(result.value.sandboxes[0])).toBe(true);
			expect(Object.isFrozen(result.value.sandboxes[0].labels)).toBe(true);
			expect(Object.keys(result.value.sandboxes[0])).toEqual(["id", "status", "labels"]);
		}
	});

	it("accepts all exact known statuses", () => {
		for (const status of ["PENDING", "PROVISIONING", "RUNNING", "PAUSED", "ERROR", "TERMINATED", "TIMEOUT"]) {
			const result = parsePrimeSandboxListOutput(mutateListRow("status", status), fixture.expectedLabel);
			expect(result.ok).toBe(true);
		}
	});

	it("accepts an empty page as proven zero matches", () => {
		const value = { sandboxes: [], total: 0, page: 1, per_page: 100, has_next: false };
		expect(parsePrimeSandboxListOutput(listOutput(value), fixture.expectedLabel)).toEqual({
			ok: true,
			value: { sandboxes: [], total: 0, page: 1, perPage: 100, hasNext: false },
		});
	});

	it("tolerates benign unknown keys without retaining them", () => {
		const value = structuredClone(fixture.list);
		Object.defineProperty(value, "future", { value: { nested: true }, enumerable: true });
		Object.defineProperty(value.sandboxes[0], "future", { value: 7, enumerable: true });
		expect(parsePrimeSandboxListOutput(listOutput(value), fixture.expectedLabel).ok).toBe(true);
	});

	for (const [name, output] of [
		["invalid JSON", "{"],
		["array root", "[]"],
		["empty input", ""],
		["zero page", listOutput({ ...fixture.list, page: 0 })],
		["zero per_page", listOutput({ ...fixture.list, per_page: 0 })],
		["negative total", listOutput({ ...fixture.list, total: -1 })],
		["wrong has_next", listOutput({ ...fixture.list, has_next: "false" })],
		[
			"rows exceed per_page",
			listOutput({
				...fixture.list,
				per_page: 1,
				total: 2,
				sandboxes: [fixture.list.sandboxes[0], fixture.list.sandboxes[0]],
			}),
		],
		["rows exceed total", listOutput({ ...fixture.list, total: 0 })],
		["impossible has_next", listOutput({ ...fixture.list, total: 100, has_next: true })],
		["impossible final page", listOutput({ ...fixture.list, total: 101, has_next: false })],
		[
			"duplicate IDs",
			listOutput({
				...fixture.list,
				total: 2,
				sandboxes: [fixture.list.sandboxes[0], fixture.list.sandboxes[0]],
			}),
		],
		["label mismatch", listOutput()],
	] as const) {
		it(`rejects ${name}`, () => {
			const label = name === "label mismatch" ? "other-label" : fixture.expectedLabel;
			expectFailure(parsePrimeSandboxListOutput(output, label));
		});
	}

	for (const [field, value] of [
		["id", "sb_"],
		["id", "sb_abcg"],
		["name", "é".repeat(257)],
		["image", ""],
		["resources", ""],
		["region", 4],
		["labels", null],
		["labels", [fixture.expectedLabel, 4]],
		["created_at", "abcd-ef-gh ij:kl:mn UTC"],
		["created_at", "2025-02-29 01:02:03 UTC"],
		["created_at", "0000-01-01 01:02:03 UTC"],
		["timeout_minutes", 0],
		["expires_at", "2026-04-31 01:02:03 UTC"],
	] as const) {
		it(`rejects malformed row field ${field}`, () => {
			expectFailure(parsePrimeSandboxListOutput(mutateListRow(field, value), fixture.expectedLabel));
		});
	}

	it("rejects every missing required row field including nullable fields", () => {
		for (const key of [
			"id",
			"name",
			"image",
			"status",
			"resources",
			"region",
			"labels",
			"created_at",
			"timeout_minutes",
			"expires_at",
		]) {
			const value = structuredClone(fixture.list);
			Reflect.deleteProperty(value.sandboxes[0], key);
			expectFailure(parsePrimeSandboxListOutput(listOutput(value), fixture.expectedLabel));
		}
	});

	it("rejects invalid or secret-bearing expected labels as input", () => {
		expectFailure(parsePrimeSandboxListOutput(listOutput(), ""), "INPUT_INVALID");
		expectFailure(parsePrimeSandboxListOutput(listOutput(), "bad\nlabel"), "INPUT_INVALID");
		expectFailure(parsePrimeSandboxListOutput(listOutput(), "é".repeat(257)), "INPUT_INVALID");
	});

	it("bounds the raw output by UTF-8 bytes", () => {
		const output = `${listOutput()}${"é".repeat(524_288)}`;
		expect(output.length).toBeLessThan(1_048_576);
		expectFailure(parsePrimeSandboxListOutput(output, fixture.expectedLabel));
	});

	it("never reflects an ID, label, or raw fragment in failure", () => {
		const result = parsePrimeSandboxListOutput(mutateListRow("status", "UNKNOWN_SECRET"), fixture.expectedLabel);
		expectFailure(result);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("UNKNOWN_SECRET");
		expect(serialized).not.toContain("sb_abc123");
		expect(serialized).not.toContain(fixture.expectedLabel);
	});
});

describe("Prime CLI 0.6.21 get JSON codec", () => {
	it("accepts and retains only lifecycle fields", () => {
		const result = parsePrimeSandboxGetOutput(getOutput(), "sb_abc123", fixture.expectedLabel);
		expect(result).toEqual({
			ok: true,
			value: { id: "sb_abc123", status: "RUNNING", labels: [fixture.expectedLabel], vm: false, type: "Container" },
		});
		expect(Object.isFrozen(result)).toBe(true);
		if (result.ok) {
			expect(Object.isFrozen(result.value)).toBe(true);
			expect(Object.isFrozen(result.value.labels)).toBe(true);
			expect(Object.keys(result.value)).toEqual(["id", "status", "labels", "vm", "type"]);
			expect(JSON.stringify(result)).not.toContain("TOKEN");
			expect(JSON.stringify(result)).not.toContain("VISIBLE");
		}
	});

	it("accepts a consistent VM detail structurally", () => {
		const value = { ...fixture.get, vm: true, type: "VM" };
		expect(parsePrimeSandboxGetOutput(getOutput(value), "sb_abc123", fixture.expectedLabel).ok).toBe(true);
	});

	it("rejects expected identity and label mismatches", () => {
		expectFailure(parsePrimeSandboxGetOutput(getOutput(), "sb_def456", fixture.expectedLabel));
		expectFailure(parsePrimeSandboxGetOutput(getOutput(), "sb_abc123", "other-label"));
	});

	it("rejects inconsistent type/vm", () => {
		expectFailure(
			parsePrimeSandboxGetOutput(
				getOutput({ ...fixture.get, vm: true, type: "Container" }),
				"sb_abc123",
				fixture.expectedLabel,
			),
		);
		expectFailure(
			parsePrimeSandboxGetOutput(
				getOutput({ ...fixture.get, vm: false, type: "VM" }),
				"sb_abc123",
				fixture.expectedLabel,
			),
		);
	});

	it("requires every exact known detail field", () => {
		for (const key of [
			"id",
			"name",
			"type",
			"docker_image",
			"start_command",
			"status",
			"cpu_cores",
			"memory_gb",
			"disk_size_gb",
			"disk_mount_path",
			"gpu_count",
			"gpu_type",
			"vm",
			"network_allowlist",
			"network_denylist",
			"timeout_minutes",
			"idle_timeout_minutes",
			"termination_reason",
			"labels",
			"created_at",
			"user_id",
			"team_id",
			"region",
			"registry_credentials_id",
		]) {
			expectFailure(parsePrimeSandboxGetOutput(withoutGetKey(key), "sb_abc123", fixture.expectedLabel));
		}
	});

	for (const [key, value] of [
		["start_command", {}],
		["cpu_cores", Number.POSITIVE_INFINITY],
		["memory_gb", -1],
		["disk_size_gb", "5"],
		["disk_mount_path", ""],
		["gpu_count", 0.5],
		["gpu_type", 4],
		["network_allowlist", [4]],
		["network_denylist", "none"],
		["idle_timeout_minutes", 0],
		["termination_reason", {}],
		["registry_credentials_id", {}],
		["started_at", null],
		["terminated_at", "2025-02-29 00:00:00 UTC"],
		["exit_code", 0.5],
		["environment_vars", []],
		["environment_vars", { KEY: 4 }],
		["secrets", { KEY: 4 }],
		["advanced_configs", []],
	] as const) {
		it(`rejects wrong known detail value ${key}`, () => {
			const valueObject = structuredClone(fixture.get);
			Object.defineProperty(valueObject, key, { value, enumerable: true, configurable: true, writable: true });
			expectFailure(parsePrimeSandboxGetOutput(getOutput(valueObject), "sb_abc123", fixture.expectedLabel));
		});
	}

	it("rejects overdeep advanced config", () => {
		const advanced = { a: { b: { c: { d: { e: true } } } } };
		expectFailure(
			parsePrimeSandboxGetOutput(
				getOutput({ ...fixture.get, advanced_configs: advanced }),
				"sb_abc123",
				fixture.expectedLabel,
			),
		);
	});

	it("accepts absent optional detail fields", () => {
		const value = structuredClone(fixture.get);
		for (const key of ["started_at", "exit_code", "environment_vars", "secrets", "advanced_configs"])
			Reflect.deleteProperty(value, key);
		expect(parsePrimeSandboxGetOutput(getOutput(value), "sb_abc123", fixture.expectedLabel).ok).toBe(true);
	});

	it("rejects invalid expected inputs with opaque fixed results", () => {
		expectFailure(parsePrimeSandboxGetOutput(getOutput(), "not-an-id", fixture.expectedLabel), "INPUT_INVALID");
		expectFailure(parsePrimeSandboxGetOutput(getOutput(), "sb_abc123", "bad\nlabel"), "INPUT_INVALID");
	});
});
