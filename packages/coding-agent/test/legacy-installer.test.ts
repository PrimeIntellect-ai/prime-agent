import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const version = "1.2.3";
const nodeFile = `prime-agent-${version}.tgz`;
const nativeFile = `prime-agent-${version}-${process.platform}-${process.arch}.tar.gz`;
const digest = "a".repeat(64);
let root: string;
let harness: string;
let base: string;
let checksums = "";
const server = createServer((request, response) => {
	const found = request.url === `/releases/v${version}/SHA256SUMS`;
	response.writeHead(found ? 200 : 404);
	response.end(found ? checksums : "missing archive");
});

async function install(inventory: string, method = "auto") {
	checksums = inventory;
	const home = mkdtempSync(join(root, "home-"));
	const child = spawn("sh", [harness, version], {
		env: {
			HOME: home,
			PATH: "/usr/bin:/bin",
			TMPDIR: root,
			PRIME_AGENT_INSTALL_METHOD: method,
			PRIME_AGENT_DOWNLOAD_BASE_URL: base,
			PRIME_AGENT_INSTALLER_NONINTERACTIVE: "1",
			PRIME_AGENT_INSTALLER_PLAIN: "1",
			PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (data) => {
		output += data.toString();
	});
	child.stderr.on("data", (data) => {
		output += data.toString();
	});
	const code = await new Promise<number | null>((done, reject) => {
		child.once("error", reject);
		child.once("close", done);
	});
	expect(existsSync(join(home, ".local/share/prime-agent/.install-lock"))).toBe(false);
	expect(existsSync(join(home, ".local/bin/prime-agent"))).toBe(false);
	return { code, output };
}

describe.skipIf(process.platform === "win32")("installer release format selection", () => {
	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "legacy-installer-"));
		harness = join(root, "install.sh");
		const installer = readFileSync(resolve(__dirname, "../../../install.sh"), "utf8");
		writeFileSync(
			harness,
			installer.replace(
				/\nmain "\$@"\s*$/,
				'\nprime_agent_install_node() { printf "node-route:%s\\\\n" "$1"; }\nmain "$@"\n',
			),
		);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing server address");
		base = `http://127.0.0.1:${address.port}`;
	});
	afterAll(async () => {
		await new Promise<void>((done) => server.close(() => done()));
		rmSync(root, { recursive: true, force: true });
	});

	it("uses Node for a release whose checksum inventory only advertises npm packages", async () => {
		const result = await install(`${digest}  ${nodeFile}\n${digest}  prime-agent-ai-${version}.tgz\n`);
		expect(result.code, result.output).toBe(0);
		expect(result.output).toContain(`node-route:${version}`);
	});

	it("keeps binary-only installs strict for an npm-only release", async () => {
		const result = await install(`${digest}  ${nodeFile}\n`, "binary");
		expect(result.code).not.toBe(0);
		expect(result.output).not.toContain("node-route:");
	});

	it.each([
		["empty inventory", ""],
		["invalid npm checksum", `bad  ${nodeFile}\n`],
		["duplicate npm checksum", `${digest}  ${nodeFile}\n${digest}  ${nodeFile}\n`],
		["missing native platform", `${digest}  ${nodeFile}\n${digest}  prime-agent-${version}-other.tar.gz\n`],
		["invalid native checksum", `${digest}  ${nodeFile}\nbad  ${nativeFile}\n`],
		["missing native archive", `${digest}  ${nodeFile}\n${digest}  ${nativeFile}\n`],
	])("does not fall back after %s", async (_label, inventory) => {
		const result = await install(inventory);
		expect(result.code).not.toBe(0);
		expect(result.output).not.toContain("node-route:");
	});
});
