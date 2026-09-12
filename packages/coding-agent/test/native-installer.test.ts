import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeUpdatePlan } from "../src/cli/native-update.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

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
let redirectToHttp = false;
let insecureRequestCount = 0;
let httpBase: string;
const serveFeed: RequestListener = (request, response) => {
	if (request.url?.endsWith(".tar.gz")) beforeArchiveResponse?.();
	const data = feed.get(request.url ?? "");
	response.writeHead(data ? 200 : 404);
	response.end(data ?? "not found");
};
let server: ReturnType<typeof createHttpsServer>;
let insecureServer: ReturnType<typeof createHttpServer>;
let root: string;
let home: string;
let base: string;
let certificate: string;
const originalDispatcher = getGlobalDispatcher();
let fixtureDispatcher: Agent;

function publish(
	version: string,
	options: { broken?: boolean; missing?: boolean; link?: boolean; installer?: string } = {},
) {
	const source = mkdtempSync(join(root, "archive-"));
	for (const asset of assets) {
		if (options.missing && asset === assets[2]) continue;
		mkdirSync(dirname(join(source, asset)), { recursive: true });
		writeFileSync(join(source, asset), "fixture\n");
	}
	writeFileSync(join(source, "package.json"), JSON.stringify({ version }));
	writeFileSync(join(source, "install.sh"), options.installer ?? readFileSync(installer));
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
	feed.set(
		version.includes("-beta") ? "/beta.json" : "/latest.json",
		Buffer.from(
			JSON.stringify({
				version,
				binaries: [{ platform, file: filename, sha256: digest }],
			}),
		),
	);
	return filename;
}

function publishNodePackage(version: string) {
	const filename = `prime-agent-${version}.tgz`;
	const bytes = Buffer.from(`node package ${version}\n`);
	const digest = createHash("sha256").update(bytes).digest("hex");
	feed.set(`/releases/v${version}/${filename}`, bytes);
	feed.set(`/releases/v${version}/SHA256SUMS`, Buffer.from(`${digest}  ${filename}\n`));
}

async function install(version: string, extra: NodeJS.ProcessEnv = {}, entrypoint = installer) {
	return run("sh", [entrypoint, version], extra);
}

async function run(executable: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
	const child = spawn(executable, args, {
		cwd: home,
		env: {
			...process.env,
			HOME: home,
			TMPDIR: root,
			PATH: "/usr/bin:/bin",
			XDG_DATA_HOME: join(home, "data"),
			SHELL: "/bin/sh",
			PRIME_AGENT_INSTALL_METHOD: "binary",
			PRIME_AGENT_INSTALLER_NONINTERACTIVE: "1",
			PRIME_AGENT_INSTALLER_PLAIN: "1",
			PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL: "0",
			PRIME_AGENT_DOWNLOAD_BASE_URL: base,
			PRIME_AGENT_CODING_AGENT_DIR: join(home, "agent"),
			DO_NOT_TRACK: "1",
			CURL_CA_BUNDLE: certificate,
			NODE_EXTRA_CA_CERTS: certificate,
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

function installationRoot() {
	return join(home, "data/prime-agent");
}

function releaseDirectories() {
	return readdirSync(join(installationRoot(), "releases"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(installationRoot(), "releases", entry.name));
}

function createLsofShim() {
	const shim = mkdtempSync(join(root, "lsof-"));
	writeFileSync(
		join(shim, "lsof"),
		'#!/bin/sh\nfor candidate in "$@"; do executable="$candidate"; done\nif [ -n "$LIVE_EXECUTABLE" ] && [ "$executable" = "$LIVE_EXECUTABLE" ]; then printf "p123\\n"; exit 0; fi\nif [ -n "$UNCERTAIN_EXECUTABLE" ] && [ "$executable" = "$UNCERTAIN_EXECUTABLE" ]; then printf "cannot inspect\\n" >&2; exit 2; fi\nexit 1\n',
		{ mode: 0o755 },
	);
	return shim;
}

function daemonSocket() {
	return join(root, `prime-agent-${process.getuid?.() ?? "user"}`, "daemon.sock");
}

async function daemonExecutable() {
	const client = new DaemonClient(daemonSocket());
	try {
		await client.connect();
		return (await client.waitForHello()).runtime?.executablePath;
	} finally {
		client.close();
	}
}

describe.skipIf(process.platform === "win32")("managed compiled installer", () => {
	beforeAll(async () => {
		root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "native-installer-")));
		const key = join(root, "localhost.key");
		certificate = join(root, "localhost.crt");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				key,
				"-out",
				certificate,
				"-days",
				"1",
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
			],
			{ stdio: "ignore" },
		);
		insecureServer = createHttpServer((request, response) => {
			insecureRequestCount += 1;
			serveFeed(request, response);
		});
		fixtureDispatcher = new Agent({ connect: { ca: readFileSync(certificate) } });
		setGlobalDispatcher(fixtureDispatcher);
		await new Promise<void>((done) => insecureServer.listen(0, "127.0.0.1", done));
		const insecureAddress = insecureServer.address();
		if (!insecureAddress || typeof insecureAddress === "string") throw new Error("missing insecure server address");
		httpBase = `http://127.0.0.1:${insecureAddress.port}`;
		server = createHttpsServer({ cert: readFileSync(certificate), key: readFileSync(key) }, (request, response) => {
			if (redirectToHttp) {
				response.writeHead(302, { location: `${httpBase}${request.url ?? ""}` });
				response.end();
				return;
			}
			serveFeed(request, response);
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing server address");
		base = `https://127.0.0.1:${address.port}`;
	});
	beforeEach(() => {
		home = mkdtempSync(join(root, "home with spaces-"));
		feed.clear();
		beforeArchiveResponse = undefined;
		redirectToHttp = false;
		insecureRequestCount = 0;
		vi.stubEnv("PI_OFFLINE", "");
		vi.stubEnv("PI_SKIP_VERSION_CHECK", "");
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "");
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		if (!existsSync(daemonSocket())) return;
		const client = new DaemonClient(daemonSocket());
		try {
			await client.connect();
			const hello = await client.waitForHello();
			await client.request({ type: "shutdown", force: true });
			if (hello.supervisorPid)
				await expect
					.poll(
						() => {
							try {
								process.kill(hello.supervisorPid!, 0);
								return false;
							} catch {
								return true;
							}
						},
						{ timeout: 10000 },
					)
					.toBe(true);
		} finally {
			client.close();
		}
	});
	afterAll(async () => {
		setGlobalDispatcher(originalDispatcher);
		await fixtureDispatcher.close();
		await new Promise<void>((done) => server.close(() => done()));
		await new Promise<void>((done) => insecureServer.close(() => done()));
		rmSync(root, { recursive: true, force: true });
	});

	it.each(["binary", "node"])("rejects an HTTP download base in %s mode", async (method) => {
		const result = await install("1.0.0", {
			PRIME_AGENT_DOWNLOAD_BASE_URL: httpBase,
			PRIME_AGENT_INSTALL_METHOD: method,
		});
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("downloads require an HTTPS base URL");
		expect(insecureRequestCount).toBe(0);
	});

	it("does not let the test opt-in enable HTTP for a non-loopback origin", async () => {
		const result = await install("1.0.0", {
			PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS: "1",
			PRIME_AGENT_DOWNLOAD_BASE_URL: "http://example.invalid",
		});
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("downloads require an HTTPS base URL");
	});

	it("rejects an HTTPS-to-HTTP redirect before downloading a native release", async () => {
		publish("1.0.0");
		redirectToHttp = true;
		const result = await install("1.0.0");
		expect(result.code).not.toBe(0);
		expect(insecureRequestCount).toBe(0);
		expect(existsSync(command())).toBe(false);
	});

	it("downloads the Node package and checksum inventory over HTTPS", async () => {
		publishNodePackage("1.0.0");
		const harness = join(home, "node-download.sh");
		writeFileSync(
			harness,
			readFileSync(installer, "utf8").replace(
				/\nmain "\$@"\s*$/,
				() => `
prime_agent_validate_download_base_url
download_prime_agent_package "$1" "$prime_agent_base_url/releases/v$1/$prime_agent_package-$1.tgz" "$HOME/$prime_agent_package-$1.tgz"
`,
			),
		);
		const result = await install("1.0.0", {}, harness);
		expect(result.code, result.output).toBe(0);
		expect(readFileSync(join(home, "prime-agent-1.0.0.tgz"), "utf8")).toBe("node package 1.0.0\n");
	});

	it("rejects an HTTPS-to-HTTP redirect for the Node package route", async () => {
		publishNodePackage("1.0.0");
		redirectToHttp = true;
		const harness = join(home, "node-download.sh");
		writeFileSync(
			harness,
			readFileSync(installer, "utf8").replace(
				/\nmain "\$@"\s*$/,
				() => `
prime_agent_validate_download_base_url
download_prime_agent_package "$1" "$prime_agent_base_url/releases/v$1/$prime_agent_package-$1.tgz" "$HOME/$prime_agent_package-$1.tgz"
`,
			),
		);
		const result = await install("1.0.0", {}, harness);
		expect(result.code).not.toBe(0);
		expect(insecureRequestCount).toBe(0);
		expect(existsSync(join(home, "prime-agent-1.0.0.tgz"))).toBe(false);
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

	it("plans verified updates and restores the previous release offline", async () => {
		publish("1.0.0");
		expect((await install("1.0.0")).code).toBe(0);
		const executable = realpathSync(command());
		const plan = (force = false, rollback = false) => getNativeUpdatePlan({ force, rollback, executable });
		expect((await plan()).command).toBeUndefined();
		expect((await plan(true)).command).toBeDefined();
		await expect(plan(false, true)).rejects.toThrow("No valid previous");
		publish("1.0.1");
		const update = await plan();
		expect(update.targetVersion).toBe("1.0.1");
		expect(update.command?.args).toContain(`PRIME_AGENT_EXPECTED_CURRENT=${readlinkSync(command())}`);
		expect(update.command?.args).toContainEqual(expect.stringMatching(/^PRIME_AGENT_EXPECTED_SHA256=[a-f0-9]{64}$/));
		const result = await install("1.0.1");
		expect(result.code, result.output).toBe(0);
		const current = readlinkSync(command());
		feed.clear();
		vi.stubEnv("PI_OFFLINE", "1");
		const rollback = await plan(false, true);
		expect(rollback.targetVersion).toBe("1.0.0");
		expect(rollback.command?.args.at(-1)).toBe("--rollback");
		const restored = await install("--rollback");
		expect(restored.code, restored.output).toBe(0);
		expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe("1.0.0\n");
		expect(readlinkSync(join(dirname(command()), "previous"))).toBe(current);
	});

	it.each([
		{ damage: "missing asset", file: "theme/prime.json" },
		{ damage: "missing installer", file: "install.sh" },
		{ damage: "missing executable", file: "prime-agent" },
		{ damage: "missing metadata", file: "package.json" },
		{ damage: "broken executable", file: "prime-agent" },
	])("repairs a $damage while preserving the healthy previous release", async ({ damage, file }) => {
		for (const rollback of [true, false]) {
			publish("1.0.0");
			expect((await install("1.0.0")).code).toBe(0);
			const retained = realpathSync(command());
			publish("1.0.1");
			expect((await install("1.0.1")).code).toBe(0);
			const current = realpathSync(command());
			const previous = readlinkSync(join(dirname(command()), "previous"));
			if (damage === "broken executable") writeFileSync(current, "#!/bin/sh\nexit 1\n");
			else rmSync(join(dirname(current), file));
			const plan = await getNativeUpdatePlan({
				force: damage === "broken executable",
				rollback,
				executable: retained,
			});
			expect(plan.command?.args).toContain(`PRIME_AGENT_EXPECTED_CURRENT=${readlinkSync(command())}`);
			if (rollback) feed.clear();
			const result = await run(plan.command!.command, plan.command!.args);
			expect(result.code, result.output).toBe(0);
			expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe(rollback ? "1.0.0\n" : "1.0.1\n");
			expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
			expect(existsSync(join(installationRoot(), ".activation-state"))).toBe(false);
			rmSync(installationRoot(), { recursive: true });
		}
	});

	it.each(["no rollback handler", "no damaged-release recovery"])(
		"uses published-installer repair when the retained installer has %s",
		async (capability) => {
			let oldInstaller = readFileSync(installer, "utf8").replace("# prime-agent-native-recovery-v1\n", "");
			if (capability === "no rollback handler")
				oldInstaller = oldInstaller.replace(/\tif \[ "\$\{1:-\}" = --rollback \]; then[\s\S]*?\tfi\n/, "");
			publish("1.0.0", { installer: oldInstaller });
			expect((await install("1.0.0")).code).toBe(0);
			const retained = realpathSync(command());
			publish("1.0.1");
			expect((await install("1.0.1")).code).toBe(0);
			const current = readlinkSync(command());
			const previous = readlinkSync(join(dirname(command()), "previous"));
			rmSync(join(dirname(realpathSync(command())), "install.sh"));
			for (const rollback of [true, false])
				await expect(getNativeUpdatePlan({ force: true, rollback, executable: retained })).rejects.toThrow(
					"https://app.primeintellect.ai/prime-agent/install.sh",
				);
			expect(readlinkSync(command())).toBe(current);
			expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
			const repaired = await install("1.0.1");
			expect(repaired.code, repaired.output).toBe(0);
			expect(readlinkSync(command())).not.toBe(current);
			expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
		},
	);

	it("requires the published installer when neither retained release can supply repair assets", async () => {
		publish("1.0.0");
		expect((await install("1.0.0")).code).toBe(0);
		const executable = realpathSync(command());
		rmSync(join(dirname(executable), "theme/prime.json"));
		for (const rollback of [true, false]) {
			await expect(getNativeUpdatePlan({ force: true, rollback, executable })).rejects.toThrow(
				"published installer",
			);
		}
	});

	it("does not treat an unmanaged current link as a damaged release to repair", async () => {
		publish("1.0.0");
		expect((await install("1.0.0")).code).toBe(0);
		const executable = realpathSync(command());
		rmSync(command());
		symlinkSync(executable, command());
		await expect(getNativeUpdatePlan({ force: true, rollback: false, executable })).rejects.toThrow("not owned");
		expect(readlinkSync(command())).toBe(executable);
	});

	it.each(["HUP", "TERM", "KILL"])("keeps releases recoverable when %s interrupts rollback", async (signal) => {
		publish("1.0.0");
		expect((await install("1.0.0")).code).toBe(0);
		const restored = readlinkSync(command());
		publish("1.0.1");
		expect((await install("1.0.1")).code).toBe(0);
		const replaced = readlinkSync(command());
		const previous = join(dirname(command()), "previous");
		const shim = mkdtempSync(join(root, "interrupt-rollback-"));
		writeFileSync(
			join(shim, "mv"),
			'#!/bin/sh\n/bin/mv "$@" || exit $?\nfor destination in "$@"; do :; done\ncase "$destination" in "$INTERRUPT_BIN/prime-agent"|"$INTERRUPT_BIN/previous") if [ ! -f "$0.sent" ]; then touch "$0.sent"; kill -"$INTERRUPT_SIGNAL" "$PPID"; fi ;; esac\n',
			{ mode: 0o755 },
		);
		const result = await install("--rollback", {
			PATH: `${shim}:/usr/bin:/bin`,
			INTERRUPT_BIN: realpathSync(dirname(command())),
			INTERRUPT_SIGNAL: signal,
		});
		expect(result.code, result.output).not.toBe(0);
		expect(readlinkSync(command())).toBe(restored);
		expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe("1.0.0\n");
		if (signal === "KILL") {
			expect(readlinkSync(previous)).toBe(restored);
			expect(existsSync(resolve(dirname(command()), replaced))).toBe(true);
			expect((await install("--rollback")).code).not.toBe(0);
			rmSync(join(home, "data/prime-agent/.install-lock"), { recursive: true });
		} else {
			expect(readlinkSync(previous)).toBe(replaced);
			expect(existsSync(join(home, "data/prime-agent/.install-lock"))).toBe(false);
		}
		feed.clear();
		const plan = await getNativeUpdatePlan({ force: false, rollback: true, executable: realpathSync(command()) });
		expect(plan.targetVersion).toBe("1.0.1");
		const recovery = await run(plan.command!.command, plan.command!.args);
		expect(recovery.code, recovery.output).toBe(0);
		expect(readlinkSync(command())).toBe(replaced);
	});

	it.each(["missing", "checksum", "duplicate", "path"])(
		"rejects a %s compiled manifest without changing the installation",
		async (failure) => {
			publish("1.0.0");
			expect((await install("1.0.0")).code).toBe(0);
			const current = readlinkSync(command());
			const artifact = { platform, file: `prime-agent-1.0.1-${platform}.tar.gz`, sha256: "a".repeat(64) };
			if (failure === "checksum") artifact.sha256 = "bad";
			if (failure === "path") artifact.file = "../outside.tar.gz";
			feed.set(
				"/latest.json",
				Buffer.from(
					JSON.stringify({
						version: "1.0.1",
						binaries: failure === "missing" ? [] : failure === "duplicate" ? [artifact, artifact] : [artifact],
					}),
				),
			);
			await expect(
				getNativeUpdatePlan({ force: false, rollback: false, executable: realpathSync(command()) }),
			).rejects.toThrow();
			expect(readlinkSync(command())).toBe(current);
		},
	);

	it("keeps beta updates on the beta channel", async () => {
		publish("1.0.0-beta.1");
		expect((await install("1.0.0-beta.1")).code).toBe(0);
		publish("1.0.0-beta.2");
		publish("9.0.0");
		const plan = await getNativeUpdatePlan({ force: false, rollback: false, executable: realpathSync(command()) });
		expect(plan.targetVersion).toBe("1.0.0-beta.2");
	});

	it.each(["stale", "checksum", "rollback"])(
		"keeps the active release when %s update validation fails",
		async (failure) => {
			publish("1.0.0");
			expect((await install("1.0.0")).code).toBe(0);
			const current = readlinkSync(command());
			publish("1.0.1");
			const result = await install(
				failure === "rollback" ? "--rollback" : "1.0.1",
				failure === "stale"
					? { PRIME_AGENT_EXPECTED_CURRENT: "an older release" }
					: { PRIME_AGENT_EXPECTED_SHA256: "0".repeat(64) },
			);
			expect(result.code, result.output).not.toBe(0);
			expect(readlinkSync(command())).toBe(current);
		},
	);

	it("refuses self-update of an unmanaged executable", async () => {
		await expect(getNativeUpdatePlan({ force: true, rollback: false, executable: process.execPath })).rejects.toThrow(
			"not owned",
		);
	});

	it.each([
		"changed previous",
		"missing asset",
		"checksum marker",
		"package version",
		"executable version",
		"source symlink",
		"asset parent symlink",
	])("preserves the active release when rollback finds a %s", async (failure) => {
		publish("1.0.0");
		expect((await install("1.0.0")).code).toBe(0);
		const previousDir = dirname(realpathSync(command()));
		publish("1.0.1");
		expect((await install("1.0.1")).code).toBe(0);
		const current = readlinkSync(command());
		const previous = readlinkSync(join(dirname(command()), "previous"));
		if (failure === "missing asset") rmSync(join(previousDir, "theme/prime.json"));
		if (failure === "checksum marker") writeFileSync(join(previousDir, ".archive-sha256"), `${"b".repeat(64)}\n`);
		if (failure === "package version") writeFileSync(join(previousDir, "package.json"), '{"version":"9.9.9"}\n');
		if (failure === "executable version")
			writeFileSync(join(previousDir, "prime-agent"), "#!/bin/sh\nprintf '9.9.9\\n'\n", { mode: 0o755 });
		if (failure === "source symlink") {
			const source = join(root, "outside-install-source");
			writeFileSync(source, "https://example.com\n");
			rmSync(join(previousDir, ".install-source"));
			symlinkSync(source, join(previousDir, ".install-source"));
		}
		if (failure === "asset parent symlink") {
			const theme = join(root, "outside-theme");
			mkdirSync(theme);
			writeFileSync(join(theme, "prime.json"), "fixture\n");
			rmSync(join(previousDir, "theme"), { recursive: true });
			symlinkSync(theme, join(previousDir, "theme"), "dir");
		}
		if (failure !== "changed previous") {
			await expect(
				getNativeUpdatePlan({ force: false, rollback: true, executable: realpathSync(command()) }),
			).rejects.toThrow();
		}
		const result = await install(
			"--rollback",
			failure === "changed previous" ? { PRIME_AGENT_EXPECTED_PREVIOUS: "an older release" } : {},
		);
		expect(result.code, result.output).not.toBe(0);
		expect(readlinkSync(command())).toBe(current);
		expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
		expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe("1.0.1\n");
	});

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
		expect(existsSync(join(dirname(command()), "previous"))).toBe(false);
	});

	it.each(["HUP", "TERM"])("retains a rollback target after %s interrupts activation", async (signal) => {
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
		expect(readlinkSync(join(dirname(command()), "previous"))).toBe(replaced);
		expect(readlinkSync(command())).not.toBe(retained);
		expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe("1.0.2\n");
		expect(existsSync(join(home, "data/prime-agent/.install-lock"))).toBe(false);
		expect(existsSync(join(installationRoot(), ".activation-state"))).toBe(false);
	});

	it.each([
		["first update", ["1.0.0"], "1.0.0"],
		["subsequent update", ["1.0.0", "1.0.1"], "1.0.1"],
	] as const)(
		"recovers the exact replaced release after SIGKILL during a %s",
		async (_label, installed, replacedVersion) => {
			for (const version of ["1.0.0", "1.0.1", "1.0.2"]) publish(version);
			for (const version of installed) expect((await install(version)).code).toBe(0);
			const shim = mkdtempSync(join(root, "kill-activation-"));
			writeFileSync(
				join(shim, "mv"),
				'#!/bin/sh\n/bin/mv "$@" || exit $?\nfor destination in "$@"; do :; done\nif [ "$destination" = "$INTERRUPT_BIN/prime-agent" ]; then kill -KILL "$PPID"; fi\n',
				{ mode: 0o755 },
			);
			const killed = await install("1.0.2", {
				PATH: `${shim}:/usr/bin:/bin`,
				INTERRUPT_BIN: realpathSync(dirname(command())),
			});
			expect(killed.code, killed.output).not.toBe(0);
			expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe("1.0.2\n");
			expect(existsSync(join(installationRoot(), ".activation-state"))).toBe(true);
			expect(readdirSync(installationRoot()).some((entry) => entry.startsWith(".install."))).toBe(true);
			rmSync(join(installationRoot(), ".install-lock"), { recursive: true });
			feed.clear();
			const plan = await getNativeUpdatePlan({ force: false, rollback: true, executable: realpathSync(command()) });
			expect(plan.targetVersion).toBe(replacedVersion);
			const rollback = await run(plan.command!.command, plan.command!.args);
			expect(rollback.code, rollback.output).toBe(0);
			expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe(`${replacedVersion}\n`);
			expect(existsSync(join(installationRoot(), ".activation-state"))).toBe(false);
			expect(readdirSync(installationRoot()).some((entry) => entry.startsWith(".install."))).toBe(false);
		},
	);

	it.each(["ln", "mv", "rmdir", "rm"])("keeps recovery retryable when %s fails during recovery", async (operation) => {
		publish("1.0.0");
		publish("1.0.1");
		expect((await install("1.0.0")).code).toBe(0);
		const previous = readlinkSync(command());
		expect((await install("1.0.1")).code).toBe(0);
		const current = readlinkSync(command());
		rmSync(join(dirname(command()), "previous"));
		const state = join(installationRoot(), ".activation-state");
		writeFileSync(state, `${current}\n${previous}\n`);
		const shim = mkdtempSync(join(root, "fail-recovery-"));
		writeFileSync(
			join(shim, operation),
			`#!/bin/sh
for destination in "$@"; do :; done
case "$destination" in
 */link.??????/link|*/link.??????|"$FAIL_PREVIOUS"|"$FAIL_STATE") exit 73 ;;
esac
exec /bin/${operation} "$@"
`,
			{ mode: 0o755 },
		);
		const failed = await install("--rollback", {
			PATH: `${shim}:/usr/bin:/bin`,
			FAIL_PREVIOUS: join(dirname(command()), "previous"),
			FAIL_STATE: state,
		});
		expect(failed.code, failed.output).not.toBe(0);
		expect(readlinkSync(command())).toBe(current);
		if (operation === "rmdir") {
			// The link already changed; exit cleanup can finish the recorded recovery.
			expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
		} else {
			expect(readFileSync(state, "utf8")).toBe(`${current}\n${previous}\n`);
		}
		const retry = await install("--rollback");
		expect(retry.code, retry.output).toBe(0);
		expect(readlinkSync(command())).toBe(previous);
		expect(existsSync(state)).toBe(false);
	});

	it("recovers a completed previous-link rename after SIGKILL", async () => {
		for (const version of ["1.0.0", "1.0.1", "1.0.2"]) publish(version);
		expect((await install("1.0.0")).code).toBe(0);
		expect((await install("1.0.1")).code).toBe(0);
		const shim = mkdtempSync(join(root, "kill-after-previous-"));
		writeFileSync(
			join(shim, "mv"),
			'#!/bin/sh\n/bin/mv "$@" || exit $?\nfor destination in "$@"; do :; done\nif [ "$destination" = "$INTERRUPT_BIN/previous" ]; then kill -KILL "$PPID"; fi\n',
			{ mode: 0o755 },
		);
		const killed = await install("1.0.2", {
			PATH: `${shim}:/usr/bin:/bin`,
			INTERRUPT_BIN: realpathSync(dirname(command())),
		});
		expect(killed.code, killed.output).not.toBe(0);
		expect(existsSync(join(installationRoot(), ".activation-state"))).toBe(true);
		rmSync(join(installationRoot(), ".install-lock"), { recursive: true });
		feed.clear();
		const plan = await getNativeUpdatePlan({ force: false, rollback: true, executable: realpathSync(command()) });
		expect(plan.targetVersion).toBe("1.0.1");
		const rollback = await run(plan.command!.command, plan.command!.args);
		expect(rollback.code, rollback.output).toBe(0);
		expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe("1.0.1\n");
	});

	it("refuses ambiguous activation recovery without changing either launcher", async () => {
		for (const version of ["1.0.0", "1.0.1", "1.0.2"]) publish(version);
		const lsof = createLsofShim();
		const environment = { PATH: `${lsof}:/usr/bin:/bin` };
		expect((await install("1.0.0", environment)).code).toBe(0);
		const oldest = readlinkSync(command());
		expect((await install("1.0.1", { ...environment, LIVE_EXECUTABLE: realpathSync(command()) })).code).toBe(0);
		const middle = readlinkSync(command());
		expect(
			(await install("1.0.2", { ...environment, LIVE_EXECUTABLE: resolve(dirname(command()), oldest) })).code,
		).toBe(0);
		const current = readlinkSync(command());
		const previous = readlinkSync(join(dirname(command()), "previous"));
		writeFileSync(join(installationRoot(), ".activation-state"), `${middle}\n${oldest}\n`);
		await expect(
			getNativeUpdatePlan({ force: false, rollback: true, executable: realpathSync(command()) }),
		).rejects.toThrow("ambiguous activation recovery");
		const result = await install("--rollback", environment);
		expect(result.code, result.output).not.toBe(0);
		expect(result.output).toContain("activation recovery is ambiguous");
		expect(readlinkSync(command())).toBe(current);
		expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
		expect(readFileSync(join(installationRoot(), ".activation-state"), "utf8")).toBe(`${middle}\n${oldest}\n`);
	});

	it("prunes only inactive managed releases and safe orphan staging directories", async () => {
		for (const version of ["1.0.0", "1.0.1", "1.0.2", "1.0.3"]) publish(version);
		const lsof = createLsofShim();
		const environment = { PATH: `${lsof}:/usr/bin:/bin` };
		expect((await install("1.0.0", environment)).code).toBe(0);
		const liveRelease = dirname(realpathSync(command()));
		const orphan = join(installationRoot(), ".install.A1b2C3");
		mkdirSync(orphan);
		writeFileSync(join(orphan, "partial"), "fixture");
		const uncertainStage = join(installationRoot(), ".install.keep");
		mkdirSync(uncertainStage);
		const outside = join(root, "outside-stage");
		mkdirSync(outside);
		const stagingLink = join(installationRoot(), ".install.Z9z9Z9");
		symlinkSync(outside, stagingLink, "dir");
		expect((await install("1.0.1", environment)).code).toBe(0);
		expect(existsSync(orphan)).toBe(false);
		expect(existsSync(uncertainStage)).toBe(true);
		expect(lstatSync(stagingLink).isSymbolicLink()).toBe(true);
		const uncertainRelease = dirname(realpathSync(command()));
		const unknownRelease = join(installationRoot(), "releases/user-files");
		mkdirSync(unknownRelease);
		writeFileSync(join(unknownRelease, "keep"), "user data");
		expect((await install("1.0.2", { ...environment, LIVE_EXECUTABLE: join(liveRelease, "prime-agent") })).code).toBe(
			0,
		);
		expect(existsSync(liveRelease)).toBe(true);
		expect(releaseDirectories()).toHaveLength(4);
		expect(
			(
				await install("1.0.3", {
					...environment,
					LIVE_EXECUTABLE: join(liveRelease, "prime-agent"),
					UNCERTAIN_EXECUTABLE: join(uncertainRelease, "prime-agent"),
				})
			).code,
		).toBe(0);
		expect(existsSync(liveRelease)).toBe(true);
		expect(existsSync(uncertainRelease)).toBe(true);
		expect(readFileSync(join(unknownRelease, "keep"), "utf8")).toBe("user data");
		expect(releaseDirectories()).toHaveLength(5);
		expect((await install("1.0.3", environment)).code).toBe(0);
		expect(releaseDirectories()).toHaveLength(3);
		expect(readFileSync(join(unknownRelease, "keep"), "utf8")).toBe("user data");
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
		"installs, updates, and rolls back actual compiled releases without Node",
		async () => {
			const archive = process.env.PRIME_AGENT_TEST_ARCHIVE!;
			const name = basename(archive);
			const version = name.slice("prime-agent-".length, -`-${platform}.tar.gz`.length);
			const manifestPath = /-beta(?:\.|$)/.test(version) ? "/beta.json" : "/latest.json";
			feed.set(`/releases/v${version}/${name}`, readFileSync(archive));
			feed.set(`/releases/v${version}/SHA256SUMS`, readFileSync(join(dirname(archive), "SHA256SUMS")));
			const result = await install(version);
			expect(result.code, result.output).toBe(0);
			expect(
				execFileSync(command(), ["--version"], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } }),
			).toBe(`${version}\n`);
			const originalTarget = readlinkSync(command());
			feed.set(
				manifestPath,
				Buffer.from(
					JSON.stringify({
						version,
						binaries: [
							{ platform, file: name, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex") },
						],
					}),
				),
			);
			const reinstalled = await run(command(), ["update", "--force"]);
			expect(reinstalled.code, reinstalled.output).toBe(0);
			expect(reinstalled.output).not.toContain("Warning:");
			expect(readlinkSync(command())).not.toBe(originalTarget);
			expect(readlinkSync(command())).toMatch(/\.[A-Za-z0-9]{6}\/prime-agent$/);
			const repaired = await run(command(), ["update"]);
			expect(repaired.code, repaired.output).toBe(0);
			expect(repaired.output).toContain("already up to date");
			const previous = readlinkSync(command());
			const source = mkdtempSync(join(root, "real-release-"));
			execFileSync("tar", ["-xzf", archive, "-C", source]);
			const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { version: string };
			metadata.version = "99.0.0";
			writeFileSync(join(source, "package.json"), JSON.stringify(metadata));
			const nextFile = `prime-agent-99.0.0-${platform}.tar.gz`;
			const nextArchive = join(root, nextFile);
			execFileSync("tar", ["-czf", nextArchive, "-C", source, "."]);
			const bytes = readFileSync(nextArchive);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			feed.set(`/releases/v99.0.0/${nextFile}`, bytes);
			feed.set("/releases/v99.0.0/SHA256SUMS", Buffer.from(`${sha256}  ${nextFile}\n`));
			const nextManifest = Buffer.from(
				JSON.stringify({ version: "v99.0.0", binaries: [{ platform, file: nextFile, sha256 }] }),
			);
			feed.set(manifestPath, nextManifest);
			mkdirSync(join(home, "agent"), { recursive: true });
			writeFileSync(join(home, "agent/auth.json"), "{}\n");
			writeFileSync(
				join(home, "extension.ts"),
				readFileSync(resolve(__dirname, "fixtures/compiled-artifact-extension.ts")),
			);
			const session = await run(command(), [
				"--offline",
				"--no-context-files",
				"--no-extensions",
				"-e",
				join(home, "extension.ts"),
				"--provider",
				"artifact-faux",
				"--model",
				"artifact",
				"--no-tools",
				"-p",
				"test update",
			]);
			expect(session.code, session.output).toBe(0);
			expect(session.output).toContain("artifact-ok:");
			expect(await daemonExecutable()).toBe(realpathSync(command()));
			const updated = await run(command(), ["update"]);
			expect(updated.code, updated.output).toBe(0);
			expect(updated.output).toContain("to v99.0.0");
			expect(updated.output).not.toContain("Warning:");
			expect((await run(command(), ["--version"])).output).toBe("99.0.0\n");
			expect(await daemonExecutable()).toBe(realpathSync(command()));
			expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
			// Update discovery follows the now-active stable version, not the original archive's channel.
			feed.delete(manifestPath);
			feed.set("/latest.json", nextManifest);
			const unchanged = await run(command(), ["update"]);
			expect(unchanged.code, unchanged.output).toBe(0);
			expect(unchanged.output).toContain("already up to date");
			feed.clear();
			const restored = await run(command(), ["update", "--rollback"], { PI_OFFLINE: "1" });
			expect(restored.code, restored.output).toBe(0);
			expect(restored.output).not.toContain("Warning:");
			expect(readlinkSync(command())).toBe(previous);
			expect(await daemonExecutable()).toBe(realpathSync(command()));
			expect((await run(command(), ["--version"])).output).toBe(`${version}\n`);
			expect(readFileSync(join(home, "agent/auth.json"), "utf8")).toBe("{}\n");
		},
		120000,
	);
});
