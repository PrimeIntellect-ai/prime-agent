import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { getAgentDir } from "../config.js";
import { AutoresearchStore } from "../core/autoresearch.js";
import {
	type AvoDashboardProjection,
	AvoSessionRuntime,
	type AvoStopGate,
	reconcileAvoIntegrityForProjection,
} from "../core/avo/index.js";
import { deriveAutoresearchDashboardPayload } from "./autoresearch-dashboard.js";

const DEFAULT_DASHBOARD_PORT = 4317;
const DASHBOARD_HOST = "127.0.0.1";

export interface AvoDashboardOptions {
	port: number;
	sessionId?: string;
	openBrowser: boolean;
}

export interface AvoDashboardPayload extends AvoDashboardProjection {
	sessionId: string;
	objective?: string;
	updatedAt: string;
}

interface AvoStateFile {
	sessionId: string;
	artifactDir: string;
	avoStatePath?: string;
	autoresearchStatePath?: string;
	modifiedAt: number;
}

export function parseAvoDashboardArgs(args: string[]): AvoDashboardOptions {
	if (args[0] !== "dashboard") {
		throw new Error("Usage: prime-agent avo dashboard [--session <id>] [--port <number>] [--no-open]");
	}
	let port = DEFAULT_DASHBOARD_PORT;
	let sessionId: string | undefined;
	let openBrowser = true;
	for (let index = 1; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--no-open") {
			openBrowser = false;
			continue;
		}
		if (argument === "--port" || argument === "--session") {
			const value = args[++index];
			if (!value) throw new Error(`${argument} requires a value`);
			if (argument === "--port") port = parseDashboardPort(value);
			else sessionId = parseDashboardSessionId(value);
			continue;
		}
		if (argument.startsWith("--port=")) {
			port = parseDashboardPort(argument.slice("--port=".length));
			continue;
		}
		if (argument.startsWith("--session=")) {
			sessionId = parseDashboardSessionId(argument.slice("--session=".length));
			continue;
		}
		throw new Error(`Unknown AVO dashboard option: ${argument}`);
	}
	return { port, sessionId, openBrowser };
}

function parseDashboardPort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("AVO dashboard port must be an integer from 1 to 65535");
	}
	return port;
}

function parseDashboardSessionId(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("AVO dashboard session id is invalid");
	return value;
}

function listAvoStateFiles(agentDir: string): AvoStateFile[] {
	const root = join(agentDir, "session-artifacts");
	if (!existsSync(root)) return [];
	const files: AvoStateFile[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const artifactDir = join(root, entry.name);
		const avoStatePath = join(artifactDir, "avo", "state.json");
		const autoresearchStatePath = join(artifactDir, "autoresearch", "state.json");
		const hasAvo = existsSync(avoStatePath);
		const hasAutoresearch = existsSync(autoresearchStatePath);
		if (!hasAvo && !hasAutoresearch) continue;
		try {
			files.push({
				sessionId: entry.name,
				artifactDir,
				avoStatePath: hasAvo ? avoStatePath : undefined,
				autoresearchStatePath: hasAutoresearch ? autoresearchStatePath : undefined,
				modifiedAt: Math.max(
					hasAvo ? statSync(avoStatePath).mtimeMs : 0,
					hasAutoresearch ? statSync(autoresearchStatePath).mtimeMs : 0,
				),
			});
		} catch {
			// Session cleanup can race a dashboard poll.
		}
	}
	return files.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function selectAvoStateFile(agentDir: string, sessionId?: string): AvoStateFile {
	const files = listAvoStateFiles(agentDir);
	const selected = sessionId ? files.find((file) => file.sessionId === sessionId) : files[0];
	if (!selected) {
		throw new Error(
			sessionId
				? `no durable AVO state exists for session ${sessionId}`
				: "no durable AVO state exists yet; start a Prime task first",
		);
	}
	return selected;
}

function sessionCwd(agentDir: string, sessionId: string): string | undefined {
	const sessionPath = join(agentDir, "sessions", `${sessionId}.jsonl`);
	if (!existsSync(sessionPath)) return undefined;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(sessionPath, "r");
		const buffer = Buffer.alloc(64 * 1024);
		const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0];
		if (!firstLine) return undefined;
		const metadata = JSON.parse(firstLine) as unknown;
		if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
			return undefined;
		}
		const cwdValue = (metadata as Record<string, unknown>).cwd;
		if (typeof cwdValue !== "string") return undefined;
		const cwd = resolve(cwdValue);
		return statSync(cwd).isDirectory() ? cwd : undefined;
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function researchStopGate(stopGate: ReturnType<AutoresearchStore["evaluateStopGate"]>): AvoStopGate {
	const reasonByIndex = [...stopGate.reasons];
	const checks = Object.entries(stopGate.checks).map(([id, passed]) => ({
		id,
		label: id.replaceAll(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase()),
		passed,
		reason: passed ? undefined : reasonByIndex.shift(),
	}));
	return { passed: stopGate.passed, checks, reasons: [...stopGate.reasons] };
}

function researchDashboardPayload(selected: AvoStateFile): AvoDashboardPayload {
	const store = new AutoresearchStore(selected.artifactDir);
	const state = store.getState();
	const legacy = deriveAutoresearchDashboardPayload(selected.sessionId, state, store.evaluateStopGate());
	return {
		sessionId: selected.sessionId,
		runId: `${selected.sessionId}:research`,
		taskRunCount: 1,
		objective: legacy.objective,
		updatedAt: legacy.updatedAt,
		environment: "research",
		horizon: "long",
		verificationPolicy: "required",
		verificationClass: "research",
		status: legacy.stopGate.passed ? "completed" : "active",
		phase: legacy.currentPhase,
		phases: legacy.phases,
		metrics: [
			{ label: "Publications", value: legacy.metrics.publications },
			{ label: "Verified", value: legacy.metrics.verifiedPublications },
			{ label: "Claims", value: legacy.metrics.claims },
			{ label: "Cycles", value: legacy.metrics.cycles },
			{ label: "Experiments", value: `${legacy.metrics.completedExperiments}/${legacy.metrics.experiments}` },
			{ label: "Memories", value: legacy.metrics.memories },
		],
		sections: [
			{
				id: "reviewers",
				title: "Four specialist reviewers",
				items: legacy.reviewers.map((reviewer) => ({
					label: reviewer.label,
					value: reviewer.summary ?? reviewer.status,
					status:
						reviewer.status === "pass"
							? "ok"
							: reviewer.status === "reject"
								? "fail"
								: reviewer.status === "revise" || reviewer.status === "assigned"
									? "watch"
									: "neutral",
				})),
			},
			{
				id: "supervisor",
				title: "Retained supervisor",
				items: [
					{ label: "Binding", value: legacy.supervisor.name ?? "Not started", status: "neutral" },
					{
						label: "Trajectory",
						value: legacy.supervisor.reason ?? legacy.supervisor.status,
						status:
							legacy.supervisor.status === "intervene"
								? "fail"
								: legacy.supervisor.status === "watch"
									? "watch"
									: "neutral",
					},
				],
			},
		],
		stopGate: researchStopGate(legacy.stopGate),
	};
}

export function loadAvoDashboardPayload(agentDir: string, sessionId?: string): AvoDashboardPayload {
	const selected = selectAvoStateFile(agentDir, sessionId);
	if (!selected.avoStatePath && selected.autoresearchStatePath) return researchDashboardPayload(selected);
	const runtime = new AvoSessionRuntime(selected.artifactDir, selected.sessionId);
	const state = runtime.getState();
	if (state.routing.environment === "research" && selected.autoresearchStatePath)
		return researchDashboardPayload(selected);
	const cwd = sessionCwd(agentDir, selected.sessionId);
	const dashboardState = cwd
		? reconcileAvoIntegrityForProjection(state, cwd, [join(agentDir, "sessions"), selected.artifactDir])
		: state;
	return {
		sessionId: selected.sessionId,
		objective: dashboardState.objective,
		updatedAt: dashboardState.updatedAt,
		...runtime.adapters.get(dashboardState.routing.environment).dashboardProjection(dashboardState),
	};
}

function dashboardHtml(): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prime Agent · AVO</title><style>
:root{color-scheme:dark;--bg:#07100f;--panel:#101c19;--line:#294039;--text:#eff8f4;--muted:#91aaa1;--mint:#62e5b0;--cyan:#65d4e8;--amber:#f1c66d;--red:#ff7d83}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% -10%,#194338 0,transparent 35%),var(--bg);font:14px Inter,system-ui,sans-serif;color:var(--text)}main{width:100%;max-width:1480px;margin:auto;padding:30px}.head,.hero,.grid{display:grid;gap:18px}.head>*,.hero>*,.grid>*{min-width:0}.head{grid-template-columns:minmax(0,1fr) auto;align-items:start;margin-bottom:22px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;color:var(--mint);font-size:11px;font-weight:800}h1{font-size:clamp(30px,4vw,48px);margin:8px 0}.muted{color:var(--muted);line-height:1.5}.live{white-space:nowrap;color:var(--muted)}.dot{display:inline-block;width:9px;height:9px;background:var(--mint);border-radius:50%;box-shadow:0 0 14px var(--mint);margin-right:8px}.panel{min-width:0;background:linear-gradient(150deg,rgba(20,36,32,.97),rgba(11,23,20,.97));border:1px solid var(--line);border-radius:18px;padding:19px}.hero{grid-template-columns:minmax(0,.72fr) minmax(0,1.5fr);margin-bottom:18px}.phase{font-size:27px;font-weight:850;margin:6px 0}.objective{font-size:19px;line-height:1.45;margin:6px 0 14px;overflow-wrap:anywhere}.meta{font:12px ui-monospace,monospace;color:var(--muted);overflow-wrap:anywhere}.bar{height:9px;background:#20332e;border-radius:99px;overflow:hidden;margin-top:18px}.bar div{height:100%;background:linear-gradient(90deg,var(--mint),var(--cyan))}.graph{display:grid;grid-template-columns:repeat(var(--phase-count),minmax(125px,1fr));gap:21px;overflow-x:auto;padding:3px 1px 12px;margin-bottom:18px}.node{position:relative;min-width:125px;min-height:112px;padding:15px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}.node:not(:last-child):after{content:'→';position:absolute;right:-18px;top:42px;color:#587168}.node.complete{border-color:#357b63}.node.active{border-color:var(--mint);box-shadow:0 0 24px #65e6b416}.node b{display:block;margin:10px 0 6px}.small{font-size:12px;color:var(--muted);line-height:1.4}.grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.metric,.item{background:#0b1714;border:1px solid #22362f;border-radius:12px;padding:13px}.metric strong{display:block;font-size:24px}.metric span{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.section{margin-top:18px}.items{display:grid;gap:9px}.item{display:flex;justify-content:space-between;gap:12px;min-width:0}.item span{min-width:0;overflow-wrap:anywhere}.item span:first-child{flex:0 1 38%}.item span:last-child{flex:1 1 62%;text-align:right;color:var(--muted)}.item.ok span:last-child{color:var(--mint)}.item.watch span:last-child{color:var(--amber)}.item.fail span:last-child{color:var(--red)}.gates{display:grid;grid-template-columns:1fr 1fr;gap:7px}.gate{color:var(--muted);padding:6px}.gate.ok{color:#cbe3d9}.gate i{font-style:normal;color:var(--red);margin-right:7px}.gate.ok i{color:var(--mint)}.error{border-color:#8b4248;color:#ffd9db}.hidden{display:none}@media(max-width:900px){main{padding:18px}.head,.hero,.grid{grid-template-columns:1fr}.graph{grid-template-columns:1fr;overflow:visible}.node:not(:last-child):after{content:'↓';right:auto;left:50%;top:auto;bottom:-21px}.metrics,.gates{grid-template-columns:1fr 1fr}}
</style></head><body><main><header class="head"><div><div class="eyebrow">Prime Agent · AVO Edition</div><h1>Universal AVO control plane</h1><div class="muted">AVO is always active. The host automatically selects an evaluation adapter and task horizon, then tracks candidate lineage, evidence, memory, supervision, and progress.</div></div><div class="live"><span class="dot"></span><span id="live">Connecting…</span></div></header><div id="error" class="panel error hidden"></div><section class="hero"><div class="panel"><div class="eyebrow">Current phase</div><div id="phase" class="phase">—</div><div id="detail" class="muted"></div><div class="bar"><div id="progress" style="width:0"></div></div></div><div class="panel"><div class="eyebrow">Objective</div><div id="objective" class="objective">—</div><div id="route" class="muted"></div><div id="meta" class="meta"></div></div></section><section id="graph" class="graph"></section><section class="grid"><div><div class="panel"><h2>Durable progress</h2><div id="metrics" class="metrics"></div></div><div class="panel section"><h2>Authoritative stop gate</h2><div id="gates" class="gates"></div></div></div><div id="sections"></div></section></main><script>
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}function replace(id,children){document.getElementById(id).replaceChildren(...children)}function render(d){document.getElementById('error').classList.add('hidden');document.getElementById('phase').textContent=d.phase.title;document.getElementById('detail').textContent=d.phase.detail;document.getElementById('progress').style.width=d.phase.progressPercent+'%';document.getElementById('objective').textContent=d.objective||'Not initialized';document.getElementById('route').textContent='Automatic adapter: '+d.environment+' · Horizon: '+d.horizon+' · Verification: '+d.verificationClass+'/'+d.verificationPolicy+' · Status: '+d.status;document.getElementById('meta').textContent='task run '+d.taskRunCount+' · '+d.runId+' · saved '+new Date(d.updatedAt).toLocaleString();document.getElementById('live').textContent='Live · '+new Date().toLocaleTimeString();const graph=document.getElementById('graph');graph.style.setProperty('--phase-count',String(d.phases.length));replace('graph',d.phases.map((p,i)=>{const n=el('article','node '+p.status);n.append(el('div','eyebrow',String(i+1).padStart(2,'0')+' · '+p.status),el('b','',p.title),el('div','small',p.short));return n}));replace('metrics',d.metrics.map(m=>{const n=el('div','metric');n.append(el('strong','',String(m.value)),el('span','',m.label));return n}));replace('sections',d.sections.map(s=>{const panel=el('section','panel section');panel.append(el('h2','',s.title));const items=el('div','items');items.append(...s.items.map(item=>{const n=el('div','item '+(item.status||'neutral'));n.append(el('span','',item.label),el('span','',item.value));return n}));panel.append(items);return panel}));replace('gates',d.stopGate.checks.map(g=>{const n=el('div','gate '+(g.passed?'ok':''));n.append(el('i','',g.passed?'✓':'×'),document.createTextNode(g.label));if(!g.passed&&g.reason)n.title=g.reason;return n}))}async function poll(){try{const r=await fetch('/api/state',{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Dashboard request failed');render(d)}catch(e){const n=document.getElementById('error');n.textContent=String(e.message||e);n.classList.remove('hidden');document.getElementById('live').textContent='Disconnected'}setTimeout(poll,2000)}poll();
</script></body></html>`;
}

function openDashboard(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.on("error", () => undefined);
	child.unref();
}

export async function runAvoDashboardCommand(args: string[]): Promise<void> {
	const options = parseAvoDashboardArgs(args);
	const agentDir = getAgentDir();
	const server = createServer((request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
		);
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405).end();
			return;
		}
		if (request.url === "/" || request.url === "/index.html") {
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(request.method === "HEAD" ? undefined : dashboardHtml());
			return;
		}
		if (request.url === "/api/state") {
			response.setHeader("Content-Type", "application/json; charset=utf-8");
			try {
				response.end(
					request.method === "HEAD"
						? undefined
						: JSON.stringify(loadAvoDashboardPayload(agentDir, options.sessionId)),
				);
			} catch (error) {
				response.statusCode = 404;
				response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			}
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, DASHBOARD_HOST, resolve);
	});
	const url = `http://${DASHBOARD_HOST}:${options.port}/`;
	console.log(`AVO dashboard: ${url}`);
	try {
		const current = loadAvoDashboardPayload(agentDir, options.sessionId);
		console.log(`Session ${current.sessionId} · ${current.environment}/${current.horizon} · ${current.phase.title}`);
	} catch (error) {
		console.log(error instanceof Error ? error.message : String(error));
	}
	console.log("Press Ctrl+C to stop the local dashboard.");
	if (options.openBrowser) openDashboard(url);
}
