import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseTailscaleArgs,
	probeTailscale,
	runTailscaleServe,
	runTailscaleStatus,
	tailscaleDoctorFacts,
} from "../src/cli/tailscale.js";

function writeShim(dir: string, script: string): string {
	writeFileSync(join(dir, "tailscale"), script, { mode: 0o755 });
	return dir;
}

/** Fake tailscale printing the given `status --json` payload; logs every argv to argv.log. */
function shimTailscale(statusJson: string, extra = ""): { dir: string; argvs: () => string[][] } {
	const dir = mkdtempSync(join(tmpdir(), "ts-shim-"));
	const lines = [
		"#!/bin/sh",
		`echo "$@" >> ${dir}/argv.log`,
		'[ "$1" = version ] && exit 0',
		'if [ "$1" = status ]; then',
		`printf '%s' '${statusJson.replace(/'/g, "")}'; exit 0; fi`,
		'if [ "$1 $2" = "serve status" ]; then',
		`printf '%s' '${(extra || "{}").replace(/'/g, "")}'; exit 0; fi`,
		'case "$1" in serve|funnel) exit 0;; esac',
		"exit 0",
	];
	writeShim(dir, lines.join("\n"));
	return {
		dir,
		argvs: () => {
			try {
				return readFileSync(join(dir, "argv.log"), "utf8")
					.trim()
					.split("\n")
					.map((line) => line.split(" "));
			} catch {
				return [];
			}
		},
	};
}

/** serve-status JSON whose Web map proxies the given local port. */
function serveStatusFor(port: number): string {
	return JSON.stringify({
		Web: { "milk.tailnet.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
		AllowFunnel: { "milk.tailnet.ts.net:443": true },
	});
}

function erroringShim(): string {
	const dir = mkdtempSync(join(tmpdir(), "ts-shim-"));
	return writeShim(dir, '#!/bin/sh\necho "shim failure" >&2\nexit 1\n');
}

function emptyDir(): string {
	return mkdtempSync(join(tmpdir(), "ts-empty-"));
}

const ONLINE = JSON.stringify({
	BackendState: "Running",
	Self: { Online: true, HostName: "milk", DNSName: "milk.tailnet.ts.net." },
	MagicDNSSuffix: "tailnet.ts.net.",
});

const REAL_PATH = process.env.PATH;
beforeEach(() => {
	process.env.PATH = REAL_PATH;
});
afterEach(() => {
	process.env.PATH = REAL_PATH;
});

describe("probeTailscale", () => {
	it("reports a null CLI when tailscale is not on PATH", () => {
		process.env.PATH = emptyDir();
		const probe = probeTailscale();
		expect(probe.cliPath).toBeNull();
		expect(probe.onTailnet).toBe(false);
	});
	it("parses tailnet facts from a working status", () => {
		process.env.PATH = `${shimTailscale(ONLINE).dir}:${process.env.PATH}`;
		const probe = probeTailscale();
		expect(probe.onTailnet).toBe(true);
		expect(probe.magicDnsSuffix).toBe("tailnet.ts.net.");
		expect(probe.hostname).toBe("milk");
	});
	it("surfaces a CLI error line when status fails", () => {
		process.env.PATH = `${erroringShim()}:${process.env.PATH}`;
		const probe = probeTailscale();
		expect(probe.cliPath).not.toBeNull();
		expect(probe.onTailnet).toBe(false);
		expect(probe.error).toContain("shim failure");
	});
	it("covers doctor facts and probe in one pass", () => {
		expect(tailscaleDoctorFacts().length).toBe(1);
		const shim = shimTailscale(ONLINE, serveStatusFor(3000));
		process.env.PATH = `${shim.dir}:${process.env.PATH}`;
		expect(tailscaleDoctorFacts()[0]).toContain("on tailnet");
	});
	it("does not mark a healthy online node as offline", () => {
		const shim = shimTailscale(ONLINE, serveStatusFor(3000));
		process.env.PATH = `${shim.dir}:${process.env.PATH}`;
		const probe = probeTailscale();
		expect(probe.onTailnet).toBe(true);
		expect(probe.offlineButUp).toBe(false);
		expect(runTailscaleStatus()).toBe(0);
	});
	it("distinguishes a stopped backend from up-but-offline", () => {
		const stopped = JSON.stringify({
			BackendState: "Stopped",
			Self: { Online: false },
			MagicDNSSuffix: "tailnet.ts.net.",
		});
		const offline = JSON.stringify({
			BackendState: "Running",
			Self: { Online: false, HostName: "milk" },
			MagicDNSSuffix: "tailnet.ts.net.",
		});
		process.env.PATH = `${shimTailscale(stopped).dir}:${process.env.PATH}`;
		expect(probeTailscale().onTailnet).toBe(false);
		process.env.PATH = `${shimTailscale(offline).dir}:${process.env.PATH}`;
		const probe = probeTailscale();
		expect(probe.onTailnet).toBe(true);
		expect(probe.offlineButUp).toBe(true);
	});
});

describe("runTailscaleStatus", () => {
	it("exits 1 with the install hint when the CLI is missing", () => {
		process.env.PATH = emptyDir();
		expect(runTailscaleStatus()).toBe(1);
		expect(runTailscaleStatus(true)).toBe(1);
	});
	it("exits 1 when the backend is stopped", () => {
		const stopped = JSON.stringify({ BackendState: "Stopped", Self: { Online: false } });
		process.env.PATH = `${shimTailscale(stopped).dir}:${process.env.PATH}`;
		expect(runTailscaleStatus()).toBe(1);
		expect(runTailscaleStatus(true)).toBe(1);
	});
	it("exits 0 when online and prints listen->target pairs incl. TCP forwards", () => {
		const serveStatus = JSON.stringify({
			TCP: { "10000": { TCPForward: "127.0.0.1:9000" } },
			Web: { "milk.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
			AllowFunnel: {},
		});
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		process.env.PATH = `${shimTailscale(ONLINE, serveStatus).dir}:${process.env.PATH}`;
		expect(runTailscaleStatus(true)).toBe(0);
		expect(runTailscaleStatus()).toBe(0);
		const logged = spy.mock.calls.map((call) => call.join(" ")).join("\n");
		spy.mockRestore();
		expect(logged).toContain("127.0.0.1:9000");
		expect(logged).toContain("milk.tailnet.ts.net:443/ -> http://127.0.0.1:3000");
	});
});

describe("runTailscaleServe", () => {
	it("refuses ports outside 1-65535 before anything else", () => {
		const shim = shimTailscale(ONLINE);
		process.env.PATH = `${shim.dir}:${process.env.PATH}`;
		expect(runTailscaleServe(0, false)).toBe(1);
		expect(runTailscaleServe(65536, false)).toBe(1);
		expect(shim.argvs().filter((argv) => argv[0] === "serve" || argv[0] === "funnel")).toEqual([]);
	});
	it("refuses serve when the CLI is missing", () => {
		process.env.PATH = emptyDir();
		expect(runTailscaleServe(3000, false)).toBe(1);
	});
	it("builds serve/funnel --bg localhost:<port>", () => {
		const shim = shimTailscale(ONLINE, serveStatusFor(3000));
		process.env.PATH = `${shim.dir}:${process.env.PATH}`;
		expect(runTailscaleServe(3000, false)).toBe(0);
		expect(runTailscaleServe(3000, true)).toBe(0);
		const spawned = shim
			.argvs()
			.filter((argv) => (argv[0] === "serve" || argv[0] === "funnel") && argv[1] !== "status");
		expect(spawned).toEqual([
			["serve", "--bg", "localhost:3000"],
			["funnel", "--bg", "localhost:3000"],
		]);
		const notPublic = shimTailscale(
			ONLINE,
			serveStatusFor(3000).replace('"milk.tailnet.ts.net:443":true', '"milk.tailnet.ts.net:443":false'),
		);
		process.env.PATH = `${notPublic.dir}:${process.env.PATH}`;
		expect(runTailscaleServe(3000, true)).toBe(1); // funnel requested, endpoint not funnel-enabled
	});
});

describe("parseTailscaleArgs", () => {
	it("requires a port for serve and never guesses a default", () => {
		expect(parseTailscaleArgs(["serve"]).kind).toBe("error");
		expect(parseTailscaleArgs(["--funnel"]).kind).toBe("error");
	});
	it("accepts --port n, --port=n, and --funnel together", () => {
		expect(parseTailscaleArgs(["serve", "--port", "3000"])).toEqual({ kind: "serve", port: 3000, funnel: false });
		expect(parseTailscaleArgs(["serve", "--port=3000"])).toEqual({ kind: "serve", port: 3000, funnel: false });
		expect(parseTailscaleArgs(["--port", "3000", "--funnel"])).toEqual({ kind: "serve", port: 3000, funnel: true });
		expect(parseTailscaleArgs(["--port", "abc"]).kind).toBe("error");
	});
	it("treats no args as status, honors --json, and rejects unknown subcommands", () => {
		expect(parseTailscaleArgs([])).toEqual({ kind: "status", json: false });
		expect(parseTailscaleArgs(["status", "--json"])).toEqual({ kind: "status", json: true });
		expect(parseTailscaleArgs(["bogus"]).kind).toBe("error");
	});
	it("rejects unconsumed, repeated, and conflicting arguments before any side effect", () => {
		// "--funnel false" must NOT be parsed as funnel: true (public exposure!)
		expect(parseTailscaleArgs(["serve", "--port", "3000", "--funnel", "false"]).kind).toBe("error");
		expect(parseTailscaleArgs(["serve", "--port", "3000", "--port", "4000"]).kind).toBe("error");
		expect(parseTailscaleArgs(["serve", "--funel", "--port", "3000"]).kind).toBe("error");
		expect(parseTailscaleArgs(["status", "--port", "3000"]).kind).toBe("error");
		const bare = parseTailscaleArgs(["serve"]);
		expect(bare.kind).toBe("error");
		expect(bare.kind === "error" && bare.message).toContain("requires --port");
	});
});

describe("post-serve verification", () => {
	it("does not match a longer port via substring (port 80 vs localhost:8000)", () => {
		const longer = shimTailscale(
			ONLINE,
			JSON.stringify({ Web: { "milk.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:8000" } } } } }),
		);
		process.env.PATH = `${longer.dir}:${process.env.PATH}`;
		expect(runTailscaleServe(80, false)).toBe(1);
		const exactTcp = shimTailscale(ONLINE, JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:80" } } }));
		process.env.PATH = `${exactTcp.dir}:${process.env.PATH}`;
		expect(runTailscaleServe(80, false)).toBe(0);
		const defaultPort = shimTailscale(ONLINE, serveStatusFor(80).replace("http://127.0.0.1:80", "http://127.0.0.1"));
		process.env.PATH = `${defaultPort.dir}:${process.env.PATH}`;
		expect(runTailscaleServe(80, false)).toBe(0);
	});
	it("fails when tailscale exits 0 without serving the target, succeeds when it does", () => {
		const pending = shimTailscale(ONLINE); // serve-status answers {} -> target absent
		process.env.PATH = `${pending.dir}:${process.env.PATH}`;
		expect(runTailscaleServe(3000, false)).toBe(1);
		const served = shimTailscale(ONLINE, serveStatusFor(3000));
		process.env.PATH = `${served.dir}:${process.env.PATH}`;
		expect(runTailscaleServe(3000, false)).toBe(0);
	});
});

describe("status failure diagnostics", () => {
	it("reports an error for a hard status failure with empty stderr", () => {
		const dir = mkdtempSync(join(tmpdir(), "ts-shim-"));
		writeShim(dir, "#!/bin/sh\nexit 1\n");
		process.env.PATH = `${dir}:${process.env.PATH}`;
		const probe = probeTailscale();
		expect(probe.cliPath).not.toBeNull();
		expect(probe.error).toContain("no diagnostic");
		expect(runTailscaleStatus()).toBe(1);
	});
});
