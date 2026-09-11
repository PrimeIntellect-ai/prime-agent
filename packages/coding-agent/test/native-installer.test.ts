import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const installer = resolve(__dirname, "../../../install.sh");
const assets = [
	"package.json",
	"install.sh",
	"prime-agent-runtime/pyproject.toml",
	"prime-agent-runtime/src/rlm/repl.py",
	"theme/prime.json",
	"export-html/template.html",
	"photon_rs_bg.wasm",
];
const platform = `${process.platform}-${process.arch}`;
const feed = new Map<string, Buffer>();
let beforeArchiveResponse: (() => void) | undefined;
const server = createServer((request, response) => {
	if (request.url?.endsWith(".tar.gz")) beforeArchiveResponse?.();
	const data = feed.get(request.url ?? "");
	response.writeHead(data ? 200 : 404);
	response.end(data ?? "not found");
});
let root: string;
let home: string;
let base: string;

function publish(version: string, options: { broken?: boolean; missing?: boolean; link?: boolean } = {}) {
	const source = mkdtempSync(join(root, "archive-"));
	for (const asset of assets) {
		if (options.missing && asset === assets[2]) continue;
		mkdirSync(dirname(join(source, asset)), { recursive: true });
		writeFileSync(join(source, asset), "fixture\n");
	}
	writeFileSync(
		join(source, "prime-agent"),
		options.broken ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
		{ mode: 0o755 },
	);
	if (options.link) symlinkSync("/tmp", join(source, "outside"));
	const filename = `prime-agent-${version}-${platform}.tar.gz`;
	const archive = join(root, filename);
	execFileSync("tar", ["-czf", archive, "-C", source, "."]);
	const bytes = readFileSync(archive);
	const digest = createHash("sha256").update(bytes).digest("hex");
	feed.set(`/releases/v${version}/${filename}`, bytes);
	feed.set(`/releases/v${version}/SHA256SUMS`, Buffer.from(`${digest}  ${filename}\n`));
	return filename;
}

async function install(version: string, extra: NodeJS.ProcessEnv = {}, entrypoint = installer) {
	const child = spawn("sh", [entrypoint, version], {
		env: {
			...process.env,
			HOME: home,
			PATH: "/usr/bin:/bin",
			XDG_DATA_HOME: join(home, "data"),
			SHELL: "/bin/sh",
			PRIME_AGENT_INSTALL_METHOD: "binary",
			PRIME_AGENT_INSTALLER_NONINTERACTIVE: "1",
			PRIME_AGENT_INSTALLER_PLAIN: "1",
			PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL: "0",
			PRIME_AGENT_DOWNLOAD_BASE_URL: base,
			...extra,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		output += chunk.toString();
	});
	return await new Promise<{ code: number | null; output: string }>((done, reject) => {
		child.once("error", reject);
		child.once("close", (code) => done({ code, output }));
	});
}

function command() {
	return join(home, "data/prime-agent/bin/prime-agent");
}

describe.skipIf(process.platform === "win32")("managed compiled installer", () => {
	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "native-installer-"));
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing server address");
		base = `http://127.0.0.1:${address.port}`;
	});
	beforeEach(() => {
		home = mkdtempSync(join(root, "home with spaces-"));
		feed.clear();
		beforeArchiveResponse = undefined;
	});
	afterAll(async () => {
		await new Promise<void>((done) => server.close(() => done()));
		rmSync(root, { recursive: true, force: true });
	});

	it("defaults to a verified executable without Node, preserves user data, and retains the previous release", async () => {
		publish("1.0.0");
		publish("1.0.1");
		mkdirSync(join(home, ".prime/agent"), { recursive: true });
		writeFileSync(join(home, ".prime/agent/auth.json"), "keep credentials");
		const first = await install("1.0.0", { PRIME_AGENT_INSTALL_METHOD: "auto" });
		expect(first.code, first.output).toBe(0);
		expect(execFileSync(join(home, ".local/bin/prime-agent"), ["--version"], { encoding: "utf8" })).toBe("1.0.0\n");
		const previous = readlinkSync(command());
		const second = await install("1.0.1");
		expect(second.code, second.output).toBe(0);
		expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
		expect(readFileSync(join(home, ".prime/agent/auth.json"), "utf8")).toBe("keep credentials");
		expect(existsSync(join(home, "data/prime-agent/.install-lock"))).toBe(false);
	});

	it.each(["checksum", "missing", "broken", "link", "duplicate"])(
		"leaves the current command working after %s validation fails",
		async (failure) => {
			publish("1.0.0");
			const first = await install("1.0.0");
			expect(first.code, first.output).toBe(0);
			const target = readlinkSync(command());
			const filename = publish("1.0.1", {
				missing: failure === "missing",
				broken: failure === "broken",
				link: failure === "link",
			});
			if (failure === "checksum") feed.set(`/releases/v1.0.1/${filename}`, Buffer.from("corrupt"));
			if (failure === "duplicate")
				feed.set(
					"/releases/v1.0.1/SHA256SUMS",
					Buffer.concat([feed.get("/releases/v1.0.1/SHA256SUMS")!, feed.get("/releases/v1.0.1/SHA256SUMS")!]),
				);
			const result = await install("1.0.1");
			expect(result.code, result.output).not.toBe(0);
			expect(readlinkSync(command())).toBe(target);
			expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe("1.0.0\n");
			expect(existsSync(join(home, "data/prime-agent/.install-lock"))).toBe(false);
		},
	);

	it.each(["1.0.0", "1.0.1"])("retries the Node fallback when reinstalling or upgrading to %s", async (version) => {
		publish("1.0.0", { broken: true });
		publish("1.0.1", { broken: true });
		const harness = join(home, "fallback-installer.sh");
		writeFileSync(
			harness,
			readFileSync(installer, "utf8").replace(
				/\nmain "\$@"\s*$/,
				() => `
prime_agent_install_node() {
 mkdir -p "$HOME/.local/bin" "$HOME/.local/lib/node_modules/prime-agent/dist/bundle"
 printf '%s\\n' "$1" > "$HOME/.local/lib/node_modules/prime-agent/dist/bundle/cli.js"
 if [ ! -L "$HOME/.local/bin/prime-agent" ]; then
  ln -s ../lib/node_modules/prime-agent/dist/bundle/cli.js "$HOME/.local/bin/prime-agent"
 fi
 printf 'node-route:%s\\n' "$1"
}
main "$@"
`,
			),
		);
		const first = await install("1.0.0", { PRIME_AGENT_INSTALL_METHOD: "auto" }, harness);
		expect(first.code, first.output).toBe(0);
		expect(first.output).toContain("node-route:1.0.0");
		const publicCommand = join(home, ".local/bin/prime-agent");
		const npmLink = readlinkSync(publicCommand);
		const second = await install(version, { PRIME_AGENT_INSTALL_METHOD: "auto" }, harness);
		expect(second.code, second.output).toBe(0);
		expect(second.output).toContain(`node-route:${version}`);
		expect(readlinkSync(publicCommand)).toBe(npmLink);
		expect(readFileSync(publicCommand, "utf8")).toBe(`${version}\n`);
		expect(existsSync(command())).toBe(false);
		expect(existsSync(join(home, "data/prime-agent/.install-lock"))).toBe(false);

		// A runnable archive still cannot take over the npm-owned public command.
		publish("1.0.2");
		const compiled = await install("1.0.2", { PRIME_AGENT_INSTALL_METHOD: "auto" }, harness);
		expect(compiled.code, compiled.output).not.toBe(0);
		expect(compiled.output).toContain("refusing to replace existing command");
		expect(compiled.output).not.toContain("node-route:");
		expect(readlinkSync(publicCommand)).toBe(npmLink);
		expect(readFileSync(publicCommand, "utf8")).toBe(`${version}\n`);
		expect(existsSync(command())).toBe(false);
	});

	it("refuses to replace an unrelated public command", async () => {
		publish("1.0.0");
		mkdirSync(join(home, ".local/bin"), { recursive: true });
		writeFileSync(join(home, ".local/bin/prime-agent"), "owned by another installer");
		const result = await install("1.0.0");
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("refusing to replace existing command");
		expect(existsSync(command())).toBe(false);
	});

	it.each(["../outside", "/tmp/outside", ".", ".."])("rejects a command name containing a path: %s", async (name) => {
		publish("1.0.0");
		const result = await install("1.0.0", { PRIME_AGENT_CMD: name });
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("command name must be a basename");
		expect(existsSync(command())).toBe(false);
		expect(existsSync(join(home, ".local/outside"))).toBe(false);
	});

	it("preserves a public command replaced by another installer during download", async () => {
		publish("1.0.0");
		expect((await install("1.0.0")).code).toBe(0);
		const current = readlinkSync(command());
		const publicCommand = join(home, ".local/bin/prime-agent");
		publish("1.0.1");
		beforeArchiveResponse = () => {
			rmSync(publicCommand);
			writeFileSync(publicCommand, "owned by another installer");
		};
		const result = await install("1.0.1");
		expect(result.code, result.output).not.toBe(0);
		expect(result.output).toContain("refusing to replace existing command");
		expect(readFileSync(publicCommand, "utf8")).toBe("owned by another installer");
		expect(readlinkSync(command())).toBe(current);
	});

	it.each(["", "../releases/an-earlier-install/prime-agent"])(
		"rejects a stale migration expectation (%s)",
		async (expected) => {
			publish("1.0.1");
			publish("1.0.0");
			expect((await install("1.0.1")).code).toBe(0);
			const active = readlinkSync(command());
			const result = await install("1.0.0", { PRIME_AGENT_EXPECTED_CURRENT: expected });
			expect(result.code, result.output).not.toBe(0);
			expect(readlinkSync(command())).toBe(active);
		},
	);

	it("does not overwrite a command created at the public-link handoff", async () => {
		publish("1.0.0");
		expect((await install("1.0.0")).code).toBe(0);
		const current = readlinkSync(command());
		const publicCommand = join(home, ".local/bin/prime-agent");
		rmSync(publicCommand);
		const shim = join(root, "link-shim");
		mkdirSync(shim);
		writeFileSync(
			join(shim, "ln"),
			'#!/bin/sh\nif [ "$3" = "$RACE_COMMAND" ]; then printf "concurrent command" > "$RACE_COMMAND"; fi\nexec /bin/ln "$@"\n',
			{ mode: 0o755 },
		);
		publish("1.0.1");
		const result = await install("1.0.1", { PATH: `${shim}:/usr/bin:/bin`, RACE_COMMAND: publicCommand });
		expect(result.code, result.output).not.toBe(0);
		expect(readFileSync(publicCommand, "utf8")).toBe("concurrent command");
		expect(readlinkSync(command())).toBe(current);
	});

	it.each([
		["before", "mv", "FAIL"],
		["before", "mv", "HUP"],
		["before", "mv", "TERM"],
		["before", "mv", "KILL"],
		["after", "mv", "HUP"],
		["after", "mv", "TERM"],
		["after", "mv", "KILL"],
		["after", "ln", "HUP"],
		["after", "ln", "TERM"],
		["after", "ln", "KILL"],
	])("keeps fresh installation retryable when %s %s receives %s", async (point, operation, signal) => {
		publish("1.0.0");
		const publicCommand = join(home, ".local/bin/prime-agent");
		const shim = mkdtempSync(join(root, "fresh-activation-"));
		writeFileSync(
			join(shim, operation),
			`#!/bin/sh
interrupt() {
 if [ "$INTERRUPT_SIGNAL" = FAIL ]; then exit 73; fi
 kill -"$INTERRUPT_SIGNAL" "$PPID"
 exit 74
}
for destination in "$@"; do :; done
if [ "$destination" = "$INTERRUPT_COMMAND" ] && [ "$INTERRUPT_POINT" = before ]; then interrupt; fi
/bin/${operation} "$@" || exit $?
if [ "$destination" = "$INTERRUPT_COMMAND" ] && [ "$INTERRUPT_POINT" = after ]; then interrupt; fi
`,
			{ mode: 0o755 },
		);
		mkdirSync(join(home, ".prime/agent"), { recursive: true });
		const userData = join(home, ".prime/agent/auth.json");
		writeFileSync(userData, "keep credentials");
		const result = await install("1.0.0", {
			PATH: `${shim}:/usr/bin:/bin`,
			INTERRUPT_COMMAND:
				operation === "mv" ? join(realpathSync(home), "data/prime-agent/bin/prime-agent") : publicCommand,
			INTERRUPT_POINT: point,
			INTERRUPT_SIGNAL: signal,
		});
		expect(result.code, result.output).not.toBe(0);
		if (lstatSync(publicCommand, { throwIfNoEntry: false })) {
			expect(existsSync(publicCommand), "public command must never be a dangling symlink").toBe(true);
			expect(execFileSync(publicCommand, ["--version"], { encoding: "utf8" })).toBe("1.0.0\n");
		}
		expect(readFileSync(userData, "utf8")).toBe("keep credentials");
		const lock = join(home, "data/prime-agent/.install-lock");
		expect(existsSync(lock)).toBe(signal === "KILL");
		// SIGKILL cannot run cleanup; recover the lock after the installer has exited.
		if (signal === "KILL") rmSync(lock, { recursive: true });
		const retry = await install("1.0.0");
		expect(retry.code, retry.output).toBe(0);
		expect(execFileSync(publicCommand, ["--version"], { encoding: "utf8" })).toBe("1.0.0\n");
		expect(readFileSync(userData, "utf8")).toBe("keep credentials");
		expect(existsSync(lock)).toBe(false);
	});

	it("repairs missing assets on reinstall without replacing files used by an existing process", async () => {
		publish("1.0.0");
		expect((await install("1.0.0")).code).toBe(0);
		const previous = readlinkSync(command());
		const oldRelease = dirname(realpathSync(command()));
		rmSync(join(oldRelease, "theme/prime.json"));
		const result = await install("1.0.0");
		expect(result.code, result.output).toBe(0);
		expect(readlinkSync(command())).not.toBe(previous);
		expect(readFileSync(join(dirname(realpathSync(command())), "theme/prime.json"), "utf8")).toBe("fixture\n");
		expect(existsSync(join(oldRelease, "theme/prime.json"))).toBe(false);
		expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
	});

	it.each(["HUP", "TERM", "KILL"])("retains a rollback target after %s interrupts activation", async (signal) => {
		for (const version of ["1.0.0", "1.0.1", "1.0.2"]) publish(version);
		expect((await install("1.0.0")).code).toBe(0);
		const retained = readlinkSync(command());
		expect((await install("1.0.1")).code).toBe(0);
		const replaced = readlinkSync(command());
		const shim = mkdtempSync(join(root, "interrupt-activation-"));
		writeFileSync(
			join(shim, "mv"),
			'#!/bin/sh\n/bin/mv "$@" || exit $?\nfor destination in "$@"; do :; done\ncase "$destination" in "$INTERRUPT_BIN/prime-agent"|"$INTERRUPT_BIN/previous") if [ ! -f "$0.sent" ]; then touch "$0.sent"; kill -"$INTERRUPT_SIGNAL" "$PPID"; fi ;; esac\n',
			{ mode: 0o755 },
		);
		const result = await install("1.0.2", {
			PATH: `${shim}:/usr/bin:/bin`,
			INTERRUPT_BIN: realpathSync(dirname(command())),
			INTERRUPT_SIGNAL: signal,
		});
		expect(result.code, result.output).not.toBe(0);
		expect(readlinkSync(join(dirname(command()), "previous"))).toBe(signal === "KILL" ? retained : replaced);
		expect(readlinkSync(command())).not.toBe(retained);
		expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe("1.0.2\n");
		expect(existsSync(join(home, "data/prime-agent/.install-lock"))).toBe(signal === "KILL");
	});

	it("does not steal another installation's lock", async () => {
		publish("1.0.0");
		const first = await install("1.0.0");
		expect(first.code, first.output).toBe(0);
		const lock = join(home, "data/prime-agent/.install-lock");
		mkdirSync(lock);
		writeFileSync(join(lock, "pid"), `${process.pid}\n`);
		const result = await install("1.0.0");
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("installation is locked");
		expect(readFileSync(join(lock, "pid"), "utf8")).toBe(`${process.pid}\n`);
	});

	it("releases its installation lock after a terminal hangup", async () => {
		const harness = join(root, "hangup.sh");
		writeFileSync(
			harness,
			readFileSync(installer, "utf8").replace(
				/\nmain "\$@"\s*$/,
				() => '\nprime_agent_install_traps\nprime_agent_native_prepare_root\nkill -HUP "$$"\n',
			),
		);
		const result = await install("", {}, harness);
		expect(result.code, result.output).toBe(129);
		expect(existsSync(join(home, "data/prime-agent/.install-lock"))).toBe(false);
	});

	it("reports the supported native platform without installation or release discovery", async () => {
		const result = await install("--native-platform", { PRIME_AGENT_DOWNLOAD_BASE_URL: "http://127.0.0.1:1" });
		expect(result).toEqual({ code: 0, output: platform });
		expect(existsSync(join(home, "data/prime-agent"))).toBe(false);
	});

	it.skipIf(!process.env.PRIME_AGENT_TEST_ARCHIVE)(
		"installs the actual compiled release archive",
		async () => {
			const archive = process.env.PRIME_AGENT_TEST_ARCHIVE!;
			const name = basename(archive);
			const version = name.slice("prime-agent-".length, -`-${platform}.tar.gz`.length);
			feed.set(`/releases/v${version}/${name}`, readFileSync(archive));
			feed.set(`/releases/v${version}/SHA256SUMS`, readFileSync(join(dirname(archive), "SHA256SUMS")));
			const result = await install(version);
			expect(result.code, result.output).toBe(0);
			expect(
				execFileSync(command(), ["--version"], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } }),
			).toBe(`${version}\n`);
		},
		60000,
	);
});
