import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	createAvoPythonProbeBundle,
	startAvoPythonProbeBroker,
	startAvoVerificationBroker,
} from "../../../src/core/avo/index.js";

function openClient(socketPath: string, allowHalfOpen = false): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path: socketPath, allowHalfOpen });
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

async function anySettlesWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
	return Promise.race([
		...promises.map((promise) =>
			promise.then(
				() => true,
				() => true,
			),
		),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
	]);
}

function directChildPids(): Set<string> {
	const taskRoot = `/proc/${process.pid}/task`;
	if (!existsSync(taskRoot)) return new Set();
	return new Set(
		readdirSync(taskRoot).flatMap((taskId) => {
			const childrenPath = join(taskRoot, taskId, "children");
			return existsSync(childrenPath) ? readFileSync(childrenPath, "utf8").trim().split(/\s+/).filter(Boolean) : [];
		}),
	);
}

function attemptClient(socketPath: string): Promise<Socket> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const finish = () => resolve(socket);
		socket.once("connect", finish);
		socket.once("error", finish);
		socket.once("close", finish);
	});
}

function readResponse(socket: Socket, timeoutMs = 4_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let response = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) reject(error);
			else resolve(response);
		};
		const timeout = setTimeout(() => finish(new Error("broker response timed out")), timeoutMs);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			response += chunk;
			if (response.includes("\n")) finish();
		});
		socket.once("error", finish);
		socket.once("close", () => {
			if (!response.includes("\n")) finish(new Error("broker closed without a response"));
		});
	});
}

async function closesWithin(sockets: readonly Socket[], timeoutMs: number): Promise<void> {
	await Promise.all(
		sockets.map(
			(socket) =>
				new Promise<void>((resolve, reject) => {
					if (socket.destroyed) {
						resolve();
						return;
					}
					const timeout = setTimeout(() => reject(new Error("broker client remained open")), timeoutMs);
					socket.once("close", () => {
						clearTimeout(timeout);
						resolve();
					});
				}),
		),
	);
}

describe.sequential("issue #12: bounded AVO brokers", () => {
	test("bounds unauthenticated bytes and held partial requests", async () => {
		if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/python3")) return;
		const workspace = mkdtempSync(join(tmpdir(), "avo-broker-bounds-"));
		const socketDirectory = mkdtempSync(join(tmpdir(), "avo-broker-sockets-"));
		writeFileSync(join(workspace, "control.txt"), "control");
		const verification = await startAvoVerificationBroker({
			workspace,
			allowedCommand: "true",
			controlPaths: ["control.txt"],
		});
		const probe = await startAvoPythonProbeBroker(workspace, { socketDirectory });
		const clients: Socket[] = [];
		try {
			const oversized = await Promise.all([
				...Array.from({ length: 32 }, () => openClient(verification.socketPath, true)),
				...Array.from({ length: 32 }, () => openClient(probe.socketPath, true)),
			]);
			clients.push(...oversized);
			const oversizedResponses = oversized.map((socket) => readResponse(socket));
			for (const socket of oversized) socket.write("x".repeat(513));
			for (const response of await Promise.all(oversizedResponses)) {
				expect(response).toContain("unauthorized or invalid");
			}
			const replacements = await Promise.all([openClient(verification.socketPath), openClient(probe.socketPath)]);
			clients.push(...replacements);
			const replacementResponses = replacements.map((socket) => readResponse(socket));
			for (const socket of replacements) socket.write("x".repeat(513));
			for (const response of await Promise.all(replacementResponses)) {
				expect(response).toContain("unauthorized or invalid");
			}

			const held = await Promise.all([openClient(verification.socketPath), openClient(probe.socketPath)]);
			clients.push(...held);
			const heldResponses = held.map((socket) => readResponse(socket));
			for (const socket of held) socket.write('{"protocolVersion":');
			const drip = setInterval(() => {
				for (const socket of held) socket.write(" ");
			}, 400);
			try {
				for (const response of await Promise.all(heldResponses)) {
					expect(response).toContain("authentication timed out");
				}
			} finally {
				clearInterval(drip);
			}
		} finally {
			for (const client of clients) client.destroy();
			await Promise.all([verification.close(), probe.close()]);
			rmSync(workspace, { recursive: true, force: true });
			rmSync(socketDirectory, { recursive: true, force: true });
		}
	});

	test("responds after valid clients half-close their request stream", async () => {
		if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/python3")) return;
		const workspace = mkdtempSync(join(tmpdir(), "avo-broker-half-close-"));
		const socketDirectory = mkdtempSync(join(tmpdir(), "avo-broker-sockets-"));
		writeFileSync(join(workspace, "control.txt"), "control");
		const verification = await startAvoVerificationBroker({
			workspace,
			allowedCommand: "true",
			controlPaths: ["control.txt"],
		});
		const probe = await startAvoPythonProbeBroker(workspace, { socketDirectory });
		const verificationClient = await openClient(verification.socketPath);
		const probeClient = await openClient(probe.socketPath);
		try {
			const verificationResponse = readResponse(verificationClient);
			verificationClient.end(
				`${JSON.stringify({
					token: verification.token,
					protocolVersion: 1,
					requestId: "a".repeat(32),
					command: "true",
					cwd: workspace,
				})}\n`,
			);
			const bundle = createAvoPythonProbeBundle([
				{
					path: "candidate.py",
					contentBase64: Buffer.from("def identity(value):\n    return value\n").toString("base64"),
				},
			]);
			const probeResponse = readResponse(probeClient);
			probeClient.end(
				`${JSON.stringify({
					token: probe.token,
					protocolVersion: 3,
					plan: {
						probeVersion: 1,
						runtime: "python_call_v1",
						modulePath: "candidate.py",
						cases: [
							{
								caseId: "identity",
								callable: "identity",
								requirementIds: ["requirement"],
								args: [1],
								kwargs: {},
								expect: { kind: "return", value: 1 },
							},
						],
					},
					bundle,
				})}\n`,
			);
			for (const response of await Promise.all([verificationResponse, probeResponse])) {
				expect(JSON.parse(response)).toHaveProperty("execution");
			}
		} finally {
			verificationClient.destroy();
			probeClient.destroy();
			await Promise.all([verification.close(), probe.close()]);
			rmSync(workspace, { recursive: true, force: true });
			rmSync(socketDirectory, { recursive: true, force: true });
		}
	});

	test("caps connected clients and closes held sockets promptly", async () => {
		if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/python3")) return;
		const workspace = mkdtempSync(join(tmpdir(), "avo-broker-clients-"));
		const socketDirectory = mkdtempSync(join(tmpdir(), "avo-broker-sockets-"));
		writeFileSync(join(workspace, "control.txt"), "control");
		const verification = await startAvoVerificationBroker({
			workspace,
			allowedCommand: "true",
			controlPaths: ["control.txt"],
		});
		const probe = await startAvoPythonProbeBroker(workspace, { socketDirectory });
		const verificationClients = await Promise.all(
			Array.from({ length: 32 }, () => openClient(verification.socketPath)),
		);
		const probeClients = await Promise.all(Array.from({ length: 32 }, () => openClient(probe.socketPath)));
		try {
			for (const socket of [...verificationClients, ...probeClients]) socket.write('{"protocolVersion":');
			const overflow = await Promise.all([attemptClient(verification.socketPath), attemptClient(probe.socketPath)]);
			await closesWithin(overflow, 1_000);
			const startedAt = Date.now();
			await Promise.all([verification.close(), probe.close()]);
			expect(Date.now() - startedAt).toBeLessThan(1_000);
			await closesWithin([...verificationClients, ...probeClients], 1_000);
		} finally {
			for (const client of [...verificationClients, ...probeClients]) client.destroy();
			await Promise.all([verification.close(), probe.close()]);
			rmSync(workspace, { recursive: true, force: true });
			rmSync(socketDirectory, { recursive: true, force: true });
		}
	});

	test("bounds authenticated execution queues and aborts active work during close", async () => {
		if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/python3")) return;
		const workspace = mkdtempSync(join(tmpdir(), "avo-broker-executions-"));
		const socketDirectory = mkdtempSync(join(tmpdir(), "avo-broker-sockets-"));
		writeFileSync(join(workspace, "control.txt"), "control");
		const verification = await startAvoVerificationBroker({
			workspace,
			allowedCommand: "sleep 2",
			controlPaths: ["control.txt"],
		});
		const probe = await startAvoPythonProbeBroker(workspace, { socketDirectory });
		const verificationClients = await Promise.all(
			Array.from({ length: 10 }, () => openClient(verification.socketPath)),
		);
		const probeClients = await Promise.all(Array.from({ length: 11 }, () => openClient(probe.socketPath)));
		try {
			const childrenBefore = directChildPids();
			const verificationAccepted = verificationClients.slice(0, -1);
			const verificationAcceptedResponses = verificationAccepted.map((socket) => readResponse(socket));
			verificationAccepted.forEach((socket, index) => {
				socket.write(
					`  ${JSON.stringify({
						token: verification.token,
						protocolVersion: 1,
						requestId: (index + 1).toString(16).padStart(32, "0"),
						command: "sleep 2",
						cwd: workspace,
					})}\n`,
				);
			});

			const bundle = createAvoPythonProbeBundle([
				{
					path: "candidate.py",
					contentBase64: Buffer.from(
						"import time\ndef wait(value):\n    time.sleep(2)\n    return value\n",
					).toString("base64"),
				},
			]);
			const probeAccepted = probeClients.slice(0, -1);
			const probeAcceptedResponses = probeAccepted.map((socket) => readResponse(socket));
			for (const socket of probeAccepted) {
				socket.write(
					`  ${JSON.stringify({
						token: probe.token,
						protocolVersion: 3,
						plan: {
							probeVersion: 1,
							runtime: "python_call_v1",
							modulePath: "candidate.py",
							cases: [
								{
									caseId: "wait",
									callable: "wait",
									requirementIds: ["requirement"],
									args: [1],
									kwargs: {},
									expect: { kind: "return", value: 1 },
								},
							],
						},
						bundle,
					})}\n`,
				);
			}

			expect(await anySettlesWithin([...verificationAcceptedResponses, ...probeAcceptedResponses], 150)).toBe(false);
			const activeChildren = [...directChildPids()].filter((pid) => !childrenBefore.has(pid));
			expect(activeChildren.length).toBeGreaterThanOrEqual(3);
			const verificationCapacity = readResponse(verificationClients.at(-1)!);
			verificationClients.at(-1)!.write(
				`  ${JSON.stringify({
					token: verification.token,
					protocolVersion: 1,
					requestId: "f".repeat(32),
					command: "sleep 2",
					cwd: workspace,
				})}\n`,
			);
			const probeCapacity = readResponse(probeClients.at(-1)!);
			probeClients.at(-1)!.write(
				`  ${JSON.stringify({
					token: probe.token,
					protocolVersion: 3,
					plan: {
						probeVersion: 1,
						runtime: "python_call_v1",
						modulePath: "candidate.py",
						cases: [
							{
								caseId: "wait",
								callable: "wait",
								requirementIds: ["requirement"],
								args: [1],
								kwargs: {},
								expect: { kind: "return", value: 1 },
							},
						],
					},
					bundle,
				})}\n`,
			);
			const [verificationResponse, probeResponse] = await Promise.all([verificationCapacity, probeCapacity]);
			expect(verificationResponse).toContain("verification broker is at execution capacity");
			expect(probeResponse).toContain("probe broker is at execution capacity");
			const startedAt = Date.now();
			await Promise.all([verification.close(), probe.close()]);
			expect(Date.now() - startedAt).toBeLessThan(1_000);
			for (const pid of activeChildren) expect(existsSync(`/proc/${pid}`)).toBe(false);
			await closesWithin([...verificationClients, ...probeClients], 1_000);
			await Promise.allSettled([...verificationAcceptedResponses, ...probeAcceptedResponses]);
		} finally {
			for (const client of [...verificationClients, ...probeClients]) client.destroy();
			await Promise.all([verification.close(), probe.close()]);
			rmSync(workspace, { recursive: true, force: true });
			rmSync(socketDirectory, { recursive: true, force: true });
		}
	});
});
