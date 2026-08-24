import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

const socketPath = process.env.ENG_1148_SOCKET_PATH ?? "";
const resultPath = process.env.ENG_1148_RESULT_PATH ?? "";
if (!socketPath || !resultPath) {
	throw new Error("ENG_1148_SOCKET_PATH and ENG_1148_RESULT_PATH are required");
}

const staleGeneration = "cc870510-1c97-4253-b45c-5347b2609380";
let listRequests = 0;
let server: Server | undefined;

function writeResult(): void {
	writeFileSync(resultPath, `${JSON.stringify({ listRequests })}\n`);
}

function send(socket: Socket, message: unknown): void {
	socket.write(`${JSON.stringify(message)}\n`);
}

function stop(): void {
	server?.close(() => process.exit(0));
}

mkdirSync(dirname(socketPath), { recursive: true });
rmSync(socketPath, { force: true });
writeResult();

server = createServer((socket) => {
	socket.on("error", () => undefined);
	send(socket, {
		type: "daemon_hello",
		socketPath,
		protocol: { name: "prime-agent.daemon", version: 7 },
		schemaId: "protocol-7-schema-16-1bcb9e7f1a49",
		schemaRevision: 16,
		appVersion: "0.7.2+luna.1",
		runtime: {
			buildId: "v0.7.2-4-g2ac5f16f6-dirty",
			executablePath: "/usr/local/bin/node",
			entrypointPath: "/Users/nathanballou/.local/bin/prime-agent",
		},
		supervisorGeneration: staleGeneration,
		supervisorPid: process.pid,
		clientId: "stale-daemon-1148",
		serverCapabilities: [],
	});

	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line.trim()) continue;
			const wire = JSON.parse(line) as {
				type?: string;
				id?: string;
				command?: { type?: string; id?: string };
			};
			const command = wire.type === "command" && wire.command ? wire.command : wire;
			if (command.type === "list") {
				listRequests++;
				writeResult();
				send(socket, {
					type: "response",
					command: "list",
					id: wire.id ?? command.id,
					success: false,
					error: `Daemon supervisor generation ${staleGeneration} no longer owns its registry entry`,
				});
				continue;
			}
			if (command.type === "shutdown") {
				send(socket, { type: "response", command: "shutdown", id: wire.id ?? command.id, success: true });
				socket.end(stop);
			}
		}
	});
});

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
server.listen(socketPath, writeResult);
