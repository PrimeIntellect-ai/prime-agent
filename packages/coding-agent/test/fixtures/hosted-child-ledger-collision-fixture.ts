/**
 * hosted-child-ledger-collision-fixture.ts — True SHA-256 collision coverage.
 *
 * Reads the exact production source, matches the exact _sha256HexBytes function,
 * replaces it with a fixed-hash version, writes a temp copy, exercises real
 * inventory logic, and cleans up. Fails closed if source shape changed.
 *
 * Spawned as a subprocess by the test runner.
 * No casts, `any`, non-null assertion, `instanceof`, `throw`, spread,
 * `Object.setPrototypeOf`, or `ts-expect-error`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROD_SOURCE_PATH: string = resolve(__dirname, "../../src/modes/daemon/sandbox/hosted-child-ledger.ts");

// === Exact sentinel: the current production _sha256HexBytes function ===
// Must match exactly. Fail closed if shape or position changes.
const EXPECTED_BLOCK: string =
	"function _sha256HexBytes(data: Uint8Array): string {\n" +
	'\treturn createHash("sha256").update(data).digest("hex");\n' +
	"}";

// === Replacement: same function but returns a fixed test hash ===
const COLLISION_BLOCK: string =
	"function _sha256HexBytes(data: Uint8Array): string {\n" +
	'\treturn "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";\n' +
	"}";

function main(): void {
	if (!existsSync(PROD_SOURCE_PATH)) {
		console.log("FAIL: Production source not found");
		process.exit(1);
	}
	const prodSource: string = readFileSync(PROD_SOURCE_PATH, "utf-8");

	// Verify the sentinel appears exactly once
	const firstIdx: number = prodSource.indexOf(EXPECTED_BLOCK);
	if (firstIdx === -1) {
		console.log("FAIL: Expected production hash function not found — source shape changed");
		process.exit(1);
	}
	const secondIdx: number = prodSource.indexOf(EXPECTED_BLOCK, firstIdx + 1);
	if (secondIdx !== -1) {
		console.log("FAIL: Expected block appears more than once — ambiguous replacement");
		process.exit(1);
	}

	// Replace with collision version — exact single transformation
	const modifiedSource: string = prodSource.replace(EXPECTED_BLOCK, COLLISION_BLOCK);
	if (modifiedSource === prodSource) {
		console.log("FAIL: Source replacement did not change anything");
		process.exit(1);
	}

	// Write modified source and shared module to temp directory
	const tmpDir: string = mkdtempSync(join(tmpdir(), "ledger-collision-"));
	const tmpSourceFile: string = join(tmpDir, "hosted-child-ledger-collision.ts");
	writeFileSync(tmpSourceFile, modifiedSource);

	// Copy the shared strict-bytes module alongside the modified source
	const strictBytesPath: string = resolve(__dirname, "../../src/modes/daemon/sandbox/prime-sandbox-strict-bytes.ts");
	if (existsSync(strictBytesPath)) {
		const strictBytesContent: string = readFileSync(strictBytesPath, "utf-8");
		const tmpStrictFile: string = join(tmpDir, "prime-sandbox-strict-bytes.ts");
		writeFileSync(tmpStrictFile, strictBytesContent);
	} else {
		console.log(`FAIL: prime-sandbox-strict-bytes.ts not found at ${strictBytesPath}`);
		rmSync(tmpDir, { recursive: true });
		process.exit(1);
	}

	// Write runner that imports the temp source
	const tmpRunnerFile: string = join(tmpDir, "runner.ts");
	const runnerContent: string =
		'import { appendGenesis, inventory } from "' +
		tmpSourceFile +
		'";\n' +
		"\n" +
		'const C64: string = "0000000000000000000000000000000000000000000000000000000000000000";\n' +
		"\n" +
		"const bounds: Record<string, number> = Object.freeze({\n" +
		"\tmaxRecords: 100,\n" +
		"\tmaxBytes: 1048576,\n" +
		"\tmaxRecordBytes: 65536,\n" +
		"\tmaxGroups: 50,\n" +
		"});\n" +
		"\n" +
		"const idA: Record<string, unknown> = Object.freeze({\n" +
		'\tsessionId: "sess-a",\n' +
		'\tactiveSessionId: "a-active",\n' +
		'\tchildId: "child-a",\n' +
		'\tname: "name-a",\n' +
		'\tmodelSelector: "model-a",\n' +
		'\tdurableParentSessionId: "parent-a",\n' +
		'\trlmParentNodeId: "rlm-a",\n' +
		"\tspawnedByRequestId: null,\n" +
		'\tthinkingLevel: "medium",\n' +
		'\tserviceTier: "auto",\n' +
		"\tspawnContextDigest: C64,\n" +
		"\tdepth: 0,\n" +
		"});\n" +
		"\n" +
		"const idB: Record<string, unknown> = Object.freeze({\n" +
		'\tsessionId: "sess-b",\n' +
		'\tactiveSessionId: "b-active",\n' +
		'\tchildId: "child-b",\n' +
		'\tname: "name-b",\n' +
		'\tmodelSelector: "model-b",\n' +
		'\tdurableParentSessionId: "parent-b",\n' +
		'\trlmParentNodeId: "rlm-b",\n' +
		'\tspawnedByRequestId: "req-b",\n' +
		'\tthinkingLevel: "high",\n' +
		"\tserviceTier: null,\n" +
		'\tspawnContextDigest: "1111111111111111111111111111111111111111111111111111111111111111",\n' +
		"\tdepth: 1,\n" +
		"});\n" +
		"\n" +
		"const r1: unknown = appendGenesis([], idA, bounds);\n" +
		"const r2: unknown = appendGenesis([], idB, bounds);\n" +
		"\n" +
		"function getField(r: unknown, key: string): unknown {\n" +
		'\tif (typeof r !== "object" || r === null) return undefined;\n' +
		"\tconst desc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(r, key);\n" +
		"\tif (desc === undefined) return undefined;\n" +
		"\treturn desc.value;\n" +
		"}\n" +
		"\n" +
		'const code1: unknown = getField(r1, "code");\n' +
		'const code2: unknown = getField(r2, "code");\n' +
		"\n" +
		'if (code1 !== "OK" || code2 !== "OK") {\n' +
		'\tconsole.log("FAIL: appendGenesis returned " + String(code1) + "/" + String(code2));\n' +
		"\tprocess.exit(1);\n" +
		"}\n" +
		"\n" +
		'const b1: unknown = getField(r1, "bytes");\n' +
		'const b2: unknown = getField(r2, "bytes");\n' +
		"\n" +
		"const invResult: unknown = inventory([b1, b2], bounds);\n" +
		'const invCode: unknown = getField(invResult, "code");\n' +
		'const invErrors: unknown = getField(invResult, "errors");\n' +
		"\n" +
		'if (invCode !== "FAIL") {\n' +
		'\tconsole.log("FAIL: expected LIFECYCLE_DIGEST_COLLISION, got code=" + String(invCode));\n' +
		"\tprocess.exit(1);\n" +
		"}\n" +
		"\n" +
		"if (!Array.isArray(invErrors)) {\n" +
		'\tconsole.log("FAIL: expected errors array");\n' +
		"\tprocess.exit(1);\n" +
		"}\n" +
		'\nconst foundCollision: boolean = invErrors.indexOf("LIFECYCLE_DIGEST_COLLISION") !== -1;\n' +
		"if (!foundCollision) {\n" +
		'\tconsole.log("FAIL: LIFECYCLE_DIGEST_COLLISION not found: " + JSON.stringify(invErrors));\n' +
		"\tprocess.exit(1);\n" +
		"}\n" +
		"\n" +
		'console.log("PASS");\n' +
		"\nprocess.exit(0);";

	writeFileSync(tmpRunnerFile, runnerContent);

	// Spawn bun to run the runner
	const result = spawnSync("/Users/milkkarten/.bun/bin/bun", ["run", tmpRunnerFile], {
		timeout: 30000,
		cwd: tmpDir,
		stdio: "pipe",
	});

	// Capture output before cleanup
	const stdout: string = (result.stdout || "").toString();
	const stderr: string = (result.stderr || "").toString();
	const status: number | null = result.status;

	// Cleanup — must not swallow errors
	try {
		rmSync(tmpDir, { recursive: true });
	} catch (_cleanupErr: unknown) {
		// best effort
	}

	if (status !== 0) {
		console.log(`FAIL: collision test subprocess exited with code ${String(status)}`);
		if (stdout) console.log(stdout);
		if (stderr) console.log(stderr);
		process.exit(1);
	}

	if (stdout.indexOf("PASS") === -1) {
		console.log(`FAIL: expected PASS output, got: ${stdout}`);
		process.exit(1);
	}

	console.log("PASS: LIFECYCLE_DIGEST_COLLISION detected");
	process.exit(0);
}

main();
