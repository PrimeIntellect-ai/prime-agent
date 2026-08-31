import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	AVO_VERIFICATION_BROKER_PYTHON_AUTHORITY_ENV,
	AVO_VERIFICATION_BROKER_SOCKET_ENV,
	AVO_VERIFICATION_BROKER_TOKEN_ENV,
	avoVerificationBrokerClientTimeoutMs,
	avoVerificationBrokerGrantsPythonSemanticAuthority,
	avoVerificationBrokerReceiptMatchesWorkspace,
	captureAvoWorkspaceSnapshot,
	createAvoVerificationBrokerBashOperations,
	startAvoVerificationBroker,
} from "../src/core/avo/index.js";

describe.sequential("AVO host verification broker", () => {
	const temporaryRoots: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	test("keeps the client alive through the official 900-second suite plus response margin", () => {
		expect(avoVerificationBrokerClientTimeoutMs(30)).toBe(90_000);
		expect(avoVerificationBrokerClientTimeoutMs(900)).toBe(960_000);
		expect(avoVerificationBrokerClientTimeoutMs(9_999)).toBe(960_000);
		expect(avoVerificationBrokerClientTimeoutMs()).toBe(960_000);
	});

	test("executes one exact command outside an enclosing sandbox with a command-bound receipt", async () => {
		if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
		const workspace = mkdtempSync(join(tmpdir(), "avo-verification-broker-workspace-"));
		const hidden = mkdtempSync(join(tmpdir(), "avo-verification-broker-hidden-"));
		const hostFixtureRoot = mkdtempSync(join(tmpdir(), "avo-verification-broker-fixture-"));
		const homeSensitive = mkdtempSync(join(homedir(), ".avo-verification-sensitive-"));
		temporaryRoots.push(workspace, hidden, hostFixtureRoot, homeSensitive);
		writeFileSync(join(hidden, "secret.txt"), "host-only");
		const hostFixture = join(hostFixtureRoot, "canonical.img");
		writeFileSync(hostFixture, "canonical-image");
		writeFileSync(join(homeSensitive, "credential.txt"), "home-only");
		const command = "node --test verifier.test.cjs";
		writeFileSync(
			join(workspace, "verifier.test.cjs"),
			[
				'const test = require("node:test")',
				'const assert = require("node:assert/strict")',
				'const fs = require("node:fs")',
				`const hidden = ${JSON.stringify(join(hidden, "secret.txt"))}`,
				`const homeSensitive = ${JSON.stringify(join(homeSensitive, "credential.txt"))}`,
				'test("closed broker boundary", () => {',
				'  assert.equal(fs.readFileSync("fs.img", "utf8"), "canonical-image")',
				'  fs.writeFileSync("fs.img", "disposable-mutation")',
				'  fs.writeFileSync("build-output.txt", "disposable")',
				'  assert.equal(fs.readFileSync("build-output.txt", "utf8"), "disposable")',
				'  assert.throws(() => fs.writeFileSync("verifier.test.cjs", "tampered"))',
				"  assert.equal(fs.existsSync(hidden), false)",
				"  assert.equal(fs.existsSync(homeSensitive), false)",
				'  assert.equal(process.env.HOME, "/tmp/prime-avo-home")',
				'  assert.equal(fs.existsSync("/var/run/docker.sock"), false)',
				"  assert.equal(process.env.NODE_OPTIONS, undefined)",
				"})",
			].join("\n"),
		);
		for (const args of [
			["init", "-q"],
			["add", "verifier.test.cjs"],
			["-c", "user.email=avo@example.invalid", "-c", "user.name=AVO", "commit", "-qm", "fixture"],
		]) {
			const git = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
			expect(git.status, git.stderr).toBe(0);
		}
		const semanticWorkspaceDigest = captureAvoWorkspaceSnapshot(workspace).digest;
		const hostHome = realpathSync(homedir());
		const nodeInstallationRoot = realpathSync(dirname(dirname(process.execPath)));
		const nodeVisiblePaths = nodeInstallationRoot.startsWith(`${hostHome}${sep}`) ? [nodeInstallationRoot] : [];
		const broker = await startAvoVerificationBroker({
			workspace,
			allowedCommand: command,
			controlPaths: ["verifier.test.cjs"],
			hiddenPaths: [hidden, homeSensitive],
			privateHome: true,
			visiblePaths: nodeVisiblePaths,
			hostFixtures: [{ sourcePath: hostFixture, destinationPath: "fs.img" }],
			environment: { ...process.env, NODE_OPTIONS: "--require=/tmp/unbound-hook.cjs" },
			pythonSemanticAuthority: true,
		});
		try {
			vi.stubEnv(AVO_VERIFICATION_BROKER_SOCKET_ENV, broker.socketPath);
			vi.stubEnv(AVO_VERIFICATION_BROKER_TOKEN_ENV, broker.token);
			const operations = createAvoVerificationBrokerBashOperations();
			expect(operations).toBeDefined();
			let output = "";
			const execution = await operations!.exec(command, workspace, {
				onData: (chunk) => (output += chunk.toString("utf8")),
				timeout: 30,
			});
			expect(execution.exitCode, output).toBe(0);
			expect(output).toContain("closed broker boundary");
			expect(existsSync(join(workspace, "build-output.txt"))).toBe(false);
			expect(existsSync(join(workspace, "fs.img"))).toBe(false);
			expect(readFileSync(hostFixture, "utf8")).toBe("canonical-image");
			const receipt = operations!.lastReceipt();
			expect(receipt).toMatchObject({
				brokerId: broker.brokerId,
				sourceWorkspaceImmutable: true,
				disposableWorkspace: true,
				networkIsolated: true,
				homeIsolated: true,
				hostFixtureCount: 1,
				hostFixturesImmutable: true,
				pythonSemanticAuthority: true,
				timedOut: false,
				exitCode: 0,
				workspaceDigest: semanticWorkspaceDigest,
				postWorkspaceDigest: semanticWorkspaceDigest,
			});
			expect(receipt?.sourceDigest).toBe(receipt?.postSourceDigest);
			expect(receipt?.hostFixtureDigest).toBe(receipt?.postHostFixtureDigest);
			expect(
				avoVerificationBrokerReceiptMatchesWorkspace(command, "host_broker", receipt, semanticWorkspaceDigest),
			).toBe(true);
			expect(avoVerificationBrokerReceiptMatchesWorkspace(command, "host_broker", receipt, "0".repeat(64))).toBe(
				false,
			);

			const outerResponse = await new Promise<Record<string, unknown>>((resolveResponse, rejectResponse) => {
				const clientSource = [
					'const net=require("node:net")',
					"const [socketPath,token,command,cwd]=process.argv.slice(1)",
					"let response=''",
					"const request={protocolVersion:1,token,requestId:'a'.repeat(32),command,cwd}",
					"const socket=net.createConnection(socketPath,()=>socket.write(JSON.stringify(request)+'\\n'))",
					"socket.setEncoding('utf8')",
					"socket.on('data',chunk=>{response+=chunk;if(response.includes('\\n')){process.stdout.write(response);socket.end()}})",
					"socket.on('error',error=>{process.stderr.write(error.message);process.exitCode=1})",
				].join(";");
				const child = spawn(
					"/usr/bin/bwrap",
					[
						"--ro-bind",
						"/",
						"/",
						"--dev",
						"/dev",
						"--proc",
						"/proc",
						"--tmpfs",
						"/tmp",
						"--bind",
						workspace,
						workspace,
						"--unshare-pid",
						"--die-with-parent",
						"--chdir",
						workspace,
						"--",
						process.execPath,
						"-e",
						clientSource,
						broker.socketPath,
						broker.token,
						command,
						workspace,
					],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
				child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
				child.once("error", rejectResponse);
				child.once("close", (code) => {
					if (code !== 0) rejectResponse(new Error(`outer verification broker client failed: ${stderr}`));
					else resolveResponse(JSON.parse(stdout.trim()) as Record<string, unknown>);
				});
			});
			expect(outerResponse).toMatchObject({
				protocolVersion: 1,
				execution: {
					exitCode: 0,
					receipt: { brokerId: broker.brokerId, disposableWorkspace: true, sourceWorkspaceImmutable: true },
				},
			});

			expect(avoVerificationBrokerGrantsPythonSemanticAuthority(command, "host_broker", receipt)).toBe(false);
			vi.stubEnv(AVO_VERIFICATION_BROKER_PYTHON_AUTHORITY_ENV, "1");
			expect(avoVerificationBrokerGrantsPythonSemanticAuthority(command, "host_broker", receipt)).toBe(true);
			expect(avoVerificationBrokerGrantsPythonSemanticAuthority(`${command} -k other`, "host_broker", receipt)).toBe(
				false,
			);
			expect(
				avoVerificationBrokerGrantsPythonSemanticAuthority(command, "host_broker", {
					...receipt!,
					receiptDigest: "0".repeat(64),
				}),
			).toBe(false);

			await expect(
				operations!.exec("node --test other.test.cjs", workspace, { onData: () => undefined, timeout: 30 }),
			).rejects.toThrow("exact host-allowlisted command");
		} finally {
			await broker.close();
		}
	});
});
