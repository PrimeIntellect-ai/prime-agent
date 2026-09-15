// ENG-5343: the kernel bootstrap must install uv from the pinned, digest-verified
// release archive and never pipe a remote script into a shell.
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTarGz } from "./archive-fixtures.js";

const uvState = vi.hoisted(() => ({ sha256: {} as Record<string, string> }));

vi.mock("../src/utils/helper-tool-releases.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/helper-tool-releases.js")>();
	return {
		...actual,
		HELPER_TOOL_RELEASES: {
			...actual.HELPER_TOOL_RELEASES,
			uv: {
				...actual.HELPER_TOOL_RELEASES.uv,
				get sha256() {
					return uvState.sha256;
				},
			},
		},
	};
});

import { DEFAULT_RLM_EXTRA_IMPORT_NAMES, ensureKernelPython } from "../src/core/kernel/bootstrap.js";
import { HELPER_TOOL_RELEASES, helperToolDownloadUrl } from "../src/utils/helper-tool-releases.js";

let home = "";
let originalEnv: NodeJS.ProcessEnv;
let requests: string[] = [];

function uvAsset(): string {
	const asset = HELPER_TOOL_RELEASES.uv.assetName(process.platform, process.arch);
	if (!asset) throw new Error("unsupported test platform");
	return asset;
}

function fakeUvScript(logPath: string): string {
	return [
		"#!/bin/sh",
		`printf '%s\\n' "$*" >> "${logPath}"`,
		'if [ "$1" = "--version" ]; then echo "uv 0.0.0-fake"; exit 0; fi',
		'if [ "$1" = "python" ]; then exit 0; fi',
		'if [ "$1" = "venv" ]; then',
		'  venv="$2"; mkdir -p "$venv/bin"',
		`  cat > "$venv/bin/python" <<'PY'`,
		"#!/bin/sh",
		'if [ "$1" = "-c" ]; then',
		'  case "$2" in',
		'    "import rlm") exit 0 ;;',
		...DEFAULT_RLM_EXTRA_IMPORT_NAMES.map((name) => `    "import ${name}") exit 0 ;;`),
		'    *"_harness_methods"*) exit 0 ;;',
		"    *) exit 1 ;;",
		"  esac",
		"fi",
		"exit 0",
		"PY",
		'  chmod +x "$venv/bin/python"; exit 0',
		"fi",
		'if [ "$1" = "pip" ]; then exit 0; fi',
		"exit 2",
		"",
	].join("\n");
}

function uvArchive(logPath: string): Buffer {
	const dir = uvAsset().replace(/\.tar\.gz$/, "");
	return makeTarGz([
		{ name: `${dir}/uv`, content: fakeUvScript(logPath), mode: 0o755 },
		{ name: `${dir}/uvx`, content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
	]);
}

function serve(body: Uint8Array | (() => Response)): void {
	vi.stubGlobal("fetch", async (input: unknown) => {
		requests.push(String(input));
		return typeof body === "function" ? body() : new Response(body, { status: 200 });
	});
}

function binDir(): string {
	return join(home, ".prime", "agent", "bin");
}

describe.skipIf(process.platform === "win32")("ENG-5343 uv bootstrap", () => {
	beforeEach(() => {
		originalEnv = { ...process.env };
		home = mkdtempSync(join(tmpdir(), "eng5343-uv-"));
		requests = [];
		uvState.sha256 = {};

		// No uv anywhere; fake sh/curl record any attempt to run an installer script.
		const fakeBin = join(home, "fake-bin");
		mkdirSync(fakeBin, { recursive: true });
		for (const name of ["sh", "curl"]) {
			writeFileSync(
				join(fakeBin, name),
				`#!/bin/bash\nprintf '%s\\n' "$*" >> "${join(home, `${name}.log`)}"\nexit 99\n`,
			);
			chmodSync(join(fakeBin, name), 0o755);
		}
		process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
		process.env.HOME = home;
		process.env.PRIME_AGENT_KERNEL_VENV = join(home, "kernel-venv");
		process.env.PRIME_AGENT_INSTALL_UV = "1";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.env = originalEnv;
		rmSync(home, { recursive: true, force: true });
	});

	it("downloads the pinned uv release, verifies it, and installs it without running a shell", async () => {
		const uvLog = join(home, "uv.log");
		const archive = uvArchive(uvLog);
		uvState.sha256 = { [uvAsset()]: createHash("sha256").update(archive).digest("hex") };
		serve(archive);
		const progress: string[] = [];

		const python = await ensureKernelPython({ onProgress: (message) => progress.push(message) });

		expect(python).toBe(join(home, "kernel-venv", "bin", "python"));
		expect(requests).toEqual([helperToolDownloadUrl(HELPER_TOOL_RELEASES.uv, uvAsset())]);
		expect(requests[0]).toMatch(/^https:\/\/github\.com\/astral-sh\/uv\/releases\/download\/\d+\.\d+\.\d+\//);
		expect(readdirSync(binDir())).toEqual(["uv"]);
		expect(readFileSync(uvLog, "utf8")).toContain("python install 3.11");
		expect(existsSync(join(home, "sh.log"))).toBe(false);
		expect(existsSync(join(home, "curl.log"))).toBe(false);
		expect(progress).toContain(`› installing uv ${HELPER_TOOL_RELEASES.uv.version} (one-time)…`);
	});

	it("rejects a uv archive whose digest does not match the pinned release", async () => {
		const uvLog = join(home, "uv.log");
		uvState.sha256 = { [uvAsset()]: "0".repeat(64) };
		serve(uvArchive(uvLog));

		await expect(ensureKernelPython({ onProgress: () => {} })).rejects.toThrow(/SHA-256 mismatch/);

		expect(existsSync(uvLog)).toBe(false);
		expect(existsSync(binDir()) ? readdirSync(binDir()) : []).toEqual([]);
		expect(existsSync(join(home, "sh.log"))).toBe(false);
	});

	it("refuses to install uv when no digest is pinned for this platform", async () => {
		serve(new Uint8Array([1]));

		await expect(ensureKernelPython({ onProgress: () => {} })).rejects.toThrow(/No pinned SHA-256/);

		expect(requests).toEqual([]);
		expect(existsSync(binDir()) ? readdirSync(binDir()) : []).toEqual([]);
	});

	it("leaves nothing behind when the uv download is interrupted", async () => {
		const archive = uvArchive(join(home, "uv.log"));
		uvState.sha256 = { [uvAsset()]: createHash("sha256").update(archive).digest("hex") };
		serve(() => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(archive.subarray(0, 32));
					controller.error(new Error("connection reset"));
				},
			});
			return new Response(stream, { status: 200 });
		});

		await expect(ensureKernelPython({ onProgress: () => {} })).rejects.toThrow(/connection reset/);

		expect(existsSync(binDir()) ? readdirSync(binDir()) : []).toEqual([]);
		expect(existsSync(join(home, "sh.log"))).toBe(false);
	});

	it("does not download anything when installation is refused", async () => {
		process.env.PRIME_AGENT_INSTALL_UV = "0";
		serve(new Uint8Array([1]));

		await expect(ensureKernelPython({ onProgress: () => {} })).rejects.toThrow(/PRIME_AGENT_INSTALL_UV=1/);

		expect(requests).toEqual([]);
		expect(existsSync(join(home, "sh.log"))).toBe(false);
	});
});
