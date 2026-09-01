import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { getAgentDir } from "../config.js";
import {
	type AutoresearchReviewerRole,
	type AutoresearchState,
	type AutoresearchStopGate,
	AutoresearchStore,
} from "../core/autoresearch.js";

const DEFAULT_DASHBOARD_PORT = 4317;
const DASHBOARD_HOST = "127.0.0.1";
const REVIEWER_ROLES: readonly AutoresearchReviewerRole[] = [
	"literature_auditor",
	"prior_art_killer",
	"experimental_critic",
	"top_tier_editor",
];

const PHASE_DEFINITIONS = [
	{ id: "setup", title: "Initialize", short: "Objective and supervisor" },
	{ id: "literature", title: "Evidence map", short: "Publications, claims, field map" },
	{ id: "candidate", title: "Candidate", short: "Problem and prior-art attack" },
	{ id: "review", title: "Four reviewers", short: "Independent hostile review" },
	{ id: "experiment", title: "Experiment", short: "Falsifier and preliminary evidence" },
	{ id: "supervision", title: "Supervisor", short: "Trajectory checkpoint" },
	{ id: "final_gate", title: "Final gate", short: "Publication-grade stop condition" },
] as const;

export type AutoresearchDashboardPhaseId = (typeof PHASE_DEFINITIONS)[number]["id"];

export interface AutoresearchDashboardOptions {
	port: number;
	sessionId?: string;
	openBrowser: boolean;
}

export interface AutoresearchDashboardPayload {
	sessionId: string;
	objective?: string;
	topic?: string;
	updatedAt: string;
	currentPhase: {
		id: AutoresearchDashboardPhaseId;
		index: number;
		title: string;
		detail: string;
		progressPercent: number;
	};
	phases: Array<{
		id: AutoresearchDashboardPhaseId;
		title: string;
		short: string;
		status: "complete" | "active" | "pending";
	}>;
	metrics: {
		publications: number;
		verifiedPublications: number;
		claims: number;
		cycles: number;
		experiments: number;
		completedExperiments: number;
		memories: number;
	};
	reviewers: Array<{
		role: AutoresearchReviewerRole;
		label: string;
		status: "pending" | "assigned" | "pass" | "revise" | "reject";
		summary?: string;
	}>;
	supervisor: {
		name?: string;
		status: "not_started" | "progressing" | "watch" | "intervene";
		reason?: string;
	};
	latestCycle?: {
		cycleId: string;
		candidateId: string;
		statement: string;
		outcome: string;
		completedAt: string;
	};
	stopGate: AutoresearchStopGate;
}

interface AutoresearchStateFile {
	sessionId: string;
	statePath: string;
	artifactDir: string;
	modifiedAt: number;
}

export function parseAutoresearchDashboardArgs(args: string[]): AutoresearchDashboardOptions {
	if (args[0] !== "dashboard") {
		throw new Error("Usage: prime-agent autoresearch dashboard [--session <id>] [--port <number>] [--no-open]");
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
			if (argument === "--port") {
				port = parseDashboardPort(value);
			} else {
				sessionId = parseDashboardSessionId(value);
			}
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
		throw new Error(`Unknown autoresearch dashboard option: ${argument}`);
	}
	return { port, sessionId, openBrowser };
}

function parseDashboardPort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("autoresearch dashboard port must be an integer from 1 to 65535");
	}
	return port;
}

function parseDashboardSessionId(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new Error("autoresearch dashboard session id is invalid");
	}
	return value;
}

function listAutoresearchStateFiles(agentDir: string): AutoresearchStateFile[] {
	const root = join(agentDir, "session-artifacts");
	if (!existsSync(root)) return [];
	const files: AutoresearchStateFile[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const artifactDir = join(root, entry.name);
		const statePath = join(artifactDir, "autoresearch", "state.json");
		if (!existsSync(statePath)) continue;
		try {
			files.push({
				sessionId: entry.name,
				statePath,
				artifactDir,
				modifiedAt: statSync(statePath).mtimeMs,
			});
		} catch {
			// A session can disappear while a daemon cleanup is running. The next
			// dashboard poll will discover the remaining durable states.
		}
	}
	return files.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function selectAutoresearchStateFile(agentDir: string, sessionId?: string): AutoresearchStateFile {
	const files = listAutoresearchStateFiles(agentDir);
	const selected = sessionId ? files.find((file) => file.sessionId === sessionId) : files[0];
	if (!selected) {
		throw new Error(
			sessionId
				? `no durable autoresearch state exists for session ${sessionId}`
				: "no durable autoresearch state exists yet; start an autoresearch task first",
		);
	}
	return selected;
}

function reviewerLabel(role: AutoresearchReviewerRole): string {
	switch (role) {
		case "literature_auditor":
			return "Literature Auditor";
		case "prior_art_killer":
			return "Prior-Art Killer";
		case "experimental_critic":
			return "Experimental Critic";
		case "top_tier_editor":
			return "Top-Tier Editor";
	}
}

function currentPhaseId(state: AutoresearchState, stopGate: AutoresearchStopGate): AutoresearchDashboardPhaseId {
	if (!state.objective) return "setup";
	if (stopGate.passed) return "final_gate";
	const promoted = [...state.cycles].reverse().find((cycle) => cycle.outcome === "promoted");
	const latestCycle = state.cycles.at(-1);
	const activeExperiment = state.experiments.some(
		(experiment) => experiment.status === "planned" || experiment.status === "running",
	);
	const latestCandidateId = promoted?.candidate.candidateId ?? latestCycle?.candidate.candidateId;
	const reviewCandidateId = state.reviewerAssignments.at(-1)?.candidateId ?? latestCandidateId;
	const reviews = reviewCandidateId
		? state.collectedReviews.filter((review) => review.candidateId === reviewCandidateId)
		: [];
	const assignments = reviewCandidateId
		? state.reviewerAssignments.filter((assignment) => assignment.candidateId === reviewCandidateId)
		: [];

	if (activeExperiment) return "experiment";
	if (assignments.length > 0 && reviews.length < REVIEWER_ROLES.length) return "review";
	if (promoted) {
		if (!stopGate.checks.fourReviewSurvival) return "review";
		if (!stopGate.checks.preliminaryEvidence) return "experiment";
		if (!stopGate.checks.supervisorProgressing) return "supervision";
		return "final_gate";
	}
	if (latestCycle) {
		const supervised = state.supervision.some((item) => item.cycleId === latestCycle.cycleId);
		return supervised ? "candidate" : "supervision";
	}
	if (assignments.length > 0) return "review";
	if (state.publications.length > 0 || state.claims.length > 0) return "candidate";
	return "literature";
}

function currentPhaseDetail(
	phase: AutoresearchDashboardPhaseId,
	state: AutoresearchState,
	stopGate: AutoresearchStopGate,
): string {
	const verified = new Set(state.publicationVerifications.map((item) => item.paperId)).size;
	switch (phase) {
		case "setup":
			return "Waiting for a durable objective and retained supervisor.";
		case "literature":
			return `${verified} verified publications and ${state.claims.length} evidence-bound claims mapped.`;
		case "candidate":
			return `${state.cycles.length} completed cycles; generating or attacking the next candidate.`;
		case "review":
			return `${state.collectedReviews.length} reviewer results collected across ${state.reviewerAssignments.length} assignments.`;
		case "experiment":
			return `${state.experiments.filter((item) => item.status === "completed").length}/${state.experiments.length} experiments completed.`;
		case "supervision":
			return state.supervision.at(-1)?.reason ?? "Waiting for the retained supervisor trajectory checkpoint.";
		case "final_gate":
			return stopGate.passed
				? "Every publication-grade stop condition has passed."
				: `${stopGate.reasons.length} stop conditions remain.`;
	}
}

export function deriveAutoresearchDashboardPayload(
	sessionId: string,
	state: AutoresearchState,
	stopGate: AutoresearchStopGate,
): AutoresearchDashboardPayload {
	const phaseId = currentPhaseId(state, stopGate);
	const phaseIndex = PHASE_DEFINITIONS.findIndex((phase) => phase.id === phaseId);
	const latestCycle = state.cycles.at(-1);
	const reviewerCandidateId =
		state.reviewerAssignments.at(-1)?.candidateId ?? latestCycle?.candidate.candidateId ?? stopGate.candidateId;
	const latestSupervision = state.supervision.at(-1);
	return {
		sessionId,
		objective: state.objective,
		topic: state.topic,
		updatedAt: state.updatedAt,
		currentPhase: {
			id: phaseId,
			index: phaseIndex,
			title: PHASE_DEFINITIONS[phaseIndex]!.title,
			detail: currentPhaseDetail(phaseId, state, stopGate),
			progressPercent: Math.round((phaseIndex / (PHASE_DEFINITIONS.length - 1)) * 100),
		},
		phases: PHASE_DEFINITIONS.map((phase, index) => ({
			...phase,
			status: stopGate.passed
				? "complete"
				: index < phaseIndex
					? "complete"
					: index === phaseIndex
						? "active"
						: "pending",
		})),
		metrics: {
			publications: state.publications.length,
			verifiedPublications: new Set(state.publicationVerifications.map((item) => item.paperId)).size,
			claims: state.claims.length,
			cycles: state.cycles.length,
			experiments: state.experiments.length,
			completedExperiments: state.experiments.filter((item) => item.status === "completed").length,
			memories: state.memories.filter((item) => !item.invalidatedAt).length,
		},
		reviewers: REVIEWER_ROLES.map((role) => {
			const review = reviewerCandidateId
				? [...state.collectedReviews]
						.reverse()
						.find((item) => item.candidateId === reviewerCandidateId && item.reviewer.role === role)
				: undefined;
			const assigned = reviewerCandidateId
				? state.reviewerAssignments.some((item) => item.candidateId === reviewerCandidateId && item.role === role)
				: false;
			return {
				role,
				label: reviewerLabel(role),
				status: review?.reviewer.verdict ?? (assigned ? "assigned" : "pending"),
				...(review?.reviewer.summary ? { summary: review.reviewer.summary } : {}),
			};
		}),
		supervisor: {
			name: state.supervisor?.name,
			status: latestSupervision?.status ?? "not_started",
			...(latestSupervision?.reason ? { reason: latestSupervision.reason } : {}),
		},
		...(latestCycle
			? {
					latestCycle: {
						cycleId: latestCycle.cycleId,
						candidateId: latestCycle.candidate.candidateId,
						statement: latestCycle.candidate.statement,
						outcome: latestCycle.outcome,
						completedAt: latestCycle.completedAt,
					},
				}
			: {}),
		stopGate,
	};
}

function loadDashboardPayload(agentDir: string, sessionId?: string): AutoresearchDashboardPayload {
	const selected = selectAutoresearchStateFile(agentDir, sessionId);
	const store = new AutoresearchStore(selected.artifactDir);
	return deriveAutoresearchDashboardPayload(selected.sessionId, store.getState(), store.evaluateStopGate());
}

function dashboardHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prime Agent AVO · Autoresearch</title>
<style>
:root{color-scheme:dark;--bg:#08100f;--panel:#101b19;--panel2:#142320;--line:#2a3d38;--text:#edf7f2;--muted:#93a9a2;--mint:#65e6b4;--cyan:#67d5e8;--amber:#f3c86a;--red:#ff7d83}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 14% -10%,#183f35 0,transparent 34%),var(--bg);font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:var(--text)}main{max-width:1480px;margin:auto;padding:32px}header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:24px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;color:var(--mint);font-size:12px;font-weight:800}h1{margin:8px 0 7px;font-size:clamp(28px,4vw,48px);line-height:1.05}.subtitle{color:var(--muted);max-width:820px;line-height:1.5}.live{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px;white-space:nowrap}.dot{width:9px;height:9px;border-radius:50%;background:var(--mint);box-shadow:0 0 14px var(--mint)}.panel{background:linear-gradient(150deg,rgba(20,35,32,.96),rgba(12,23,21,.96));border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.18)}.hero{display:grid;grid-template-columns:minmax(260px,.72fr) minmax(0,1.6fr);gap:18px;margin-bottom:18px}.phase-name{font-size:27px;font-weight:800;margin:6px 0}.phase-detail{color:var(--muted);line-height:1.45}.bar{height:9px;background:#20302c;border-radius:999px;overflow:hidden;margin-top:20px}.bar>div{height:100%;background:linear-gradient(90deg,var(--mint),var(--cyan));transition:width .35s ease}.objective{font-size:19px;line-height:1.45;margin:5px 0 14px}.meta{font-family:ui-monospace,SFMono-Regular,monospace;color:var(--muted);font-size:12px}.graph{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));gap:22px;margin-bottom:18px;overflow-x:auto;padding:4px 1px 12px}.node{min-width:120px;position:relative;padding:16px 14px;border:1px solid var(--line);border-radius:15px;background:var(--panel);min-height:116px}.node:not(:last-child):after{content:'→';position:absolute;right:-19px;top:42px;color:#526a63;font-size:20px}.node.complete{border-color:#367b65;background:#10251f}.node.active{border-color:var(--mint);box-shadow:0 0 0 1px rgba(101,230,180,.18),0 0 28px rgba(101,230,180,.08)}.node-index{font:700 11px ui-monospace,SFMono-Regular,monospace;color:var(--muted)}.node.active .node-index,.node.complete .node-index{color:var(--mint)}.node-title{font-weight:800;margin:10px 0 6px}.node-short{font-size:12px;color:var(--muted);line-height:1.35}.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:18px}.section-title{margin:0 0 16px;font-size:16px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.metric{background:#0c1715;border:1px solid #22332f;border-radius:13px;padding:14px}.metric-value{font-size:25px;font-weight:850}.metric-label{font-size:11px;color:var(--muted);margin-top:4px;text-transform:uppercase;letter-spacing:.08em}.reviewers{display:grid;grid-template-columns:1fr 1fr;gap:10px}.reviewer{border:1px solid #263a35;border-radius:13px;padding:13px;background:#0c1715}.reviewer-head{display:flex;justify-content:space-between;gap:8px}.badge{font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:800;color:var(--muted)}.badge.pass{color:var(--mint)}.badge.reject{color:var(--red)}.badge.revise,.badge.assigned{color:var(--amber)}.reviewer-summary{color:var(--muted);font-size:12px;line-height:1.4;margin-top:8px}.gates{display:grid;grid-template-columns:1fr 1fr;gap:8px}.gate{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:var(--muted);padding:7px 0}.gate-mark{color:var(--red);font-weight:900}.gate.ok .gate-mark{color:var(--mint)}.gate.ok{color:#c9ddd6}.cycle{margin-top:14px;border-top:1px solid var(--line);padding-top:14px;color:var(--muted);font-size:13px;line-height:1.5}.error{border-color:#8a3e43;color:#ffd9da}.hidden{display:none}@media(max-width:900px){main{padding:20px}.hero,.grid{grid-template-columns:1fr}.graph{grid-template-columns:1fr;overflow:visible}.node:not(:last-child):after{content:'↓';right:auto;left:50%;top:auto;bottom:-22px}.metrics{grid-template-columns:1fr 1fr}header{flex-direction:column}.reviewers,.gates{grid-template-columns:1fr}}
</style>
</head>
<body><main>
<header><div><div class="eyebrow">Prime Agent · AVO Edition</div><h1>Autoresearch control plane</h1><div class="subtitle">A read-only view of durable research state. It refreshes automatically; the highlighted node is the phase supported by the latest saved evidence.</div></div><div class="live"><span class="dot"></span><span id="live-text">Connecting…</span></div></header>
<div id="error" class="panel error hidden"></div>
<section class="hero"><div class="panel"><div class="eyebrow">Current phase</div><div id="phase-name" class="phase-name">—</div><div id="phase-detail" class="phase-detail">Loading durable state…</div><div class="bar"><div id="progress" style="width:0"></div></div></div><div class="panel"><div class="eyebrow">Research objective</div><div id="objective" class="objective">—</div><div id="topic" class="subtitle"></div><div id="meta" class="meta"></div></div></section>
<section id="graph" class="graph" aria-label="Autoresearch phase graph"></section>
<section class="grid"><div><div class="panel"><h2 class="section-title">Durable progress</h2><div id="metrics" class="metrics"></div><div id="cycle" class="cycle"></div></div><div class="panel" style="margin-top:18px"><h2 class="section-title">Publication-grade stop gate</h2><div id="gates" class="gates"></div></div></div><div><div class="panel"><h2 class="section-title">Four specialist reviewers</h2><div id="reviewers" class="reviewers"></div></div><div class="panel" style="margin-top:18px"><h2 class="section-title">Retained supervisor</h2><div id="supervisor" class="phase-detail"></div></div></div></section>
</main><script>
const labels={promotedCandidate:'Promoted candidate',clearProblemStatement:'Clear problem statement',multipleRealPublications:'Verified publication motivation',latestPreprintCheck:'Latest preprint search',strongClosestPriorWorkComparison:'Closest prior-work comparison',mechanisticExplanation:'Mechanistic explanation',falsifiableHypothesis:'Falsifiable hypothesis',feasibleExperiment:'Feasible experiment',preliminaryEvidence:'Preliminary evidence',strongBaselinePlan:'Strong baseline plan',broaderRelevance:'Broader relevance',fourReviewSurvival:'Four-review survival',supervisorProgressing:'Supervisor progressing'};
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
function replace(id,children){const node=document.getElementById(id);node.replaceChildren(...children)}
function render(data){document.getElementById('error').classList.add('hidden');document.getElementById('phase-name').textContent=data.currentPhase.title;document.getElementById('phase-detail').textContent=data.currentPhase.detail;document.getElementById('progress').style.width=data.currentPhase.progressPercent+'%';document.getElementById('objective').textContent=data.objective||'Not initialized';document.getElementById('topic').textContent=data.topic||'';document.getElementById('meta').textContent='session '+data.sessionId+' · saved '+new Date(data.updatedAt).toLocaleString();document.getElementById('live-text').textContent='Live · '+new Date().toLocaleTimeString();
replace('graph',data.phases.map((phase,index)=>{const node=el('article','node '+phase.status);node.append(el('div','node-index',String(index+1).padStart(2,'0')+' · '+phase.status),el('div','node-title',phase.title),el('div','node-short',phase.short));return node}));
const metricItems=[['Publications',data.metrics.publications],['Verified',data.metrics.verifiedPublications],['Claims',data.metrics.claims],['Cycles',data.metrics.cycles],['Experiments',data.metrics.completedExperiments+'/'+data.metrics.experiments],['Memories',data.metrics.memories]];replace('metrics',metricItems.map(item=>{const node=el('div','metric');node.append(el('div','metric-value',String(item[1])),el('div','metric-label',item[0]));return node}));
document.getElementById('cycle').textContent=data.latestCycle?'Latest cycle · '+data.latestCycle.outcome+' · '+data.latestCycle.statement:'No completed candidate cycle yet.';
replace('reviewers',data.reviewers.map(item=>{const node=el('div','reviewer');const head=el('div','reviewer-head');head.append(el('strong','',item.label),el('span','badge '+item.status,item.status));node.append(head);if(item.summary)node.append(el('div','reviewer-summary',item.summary));return node}));
replace('gates',Object.entries(data.stopGate.checks).map(entry=>{const node=el('div','gate '+(entry[1]?'ok':''));node.append(el('span','gate-mark',entry[1]?'✓':'×'),el('span','',labels[entry[0]]||entry[0]));return node}));
const supervisor=data.supervisor.name||'Supervisor not bound';document.getElementById('supervisor').textContent=supervisor+' · '+data.supervisor.status+(data.supervisor.reason?' · '+data.supervisor.reason:'');}
async function refresh(){try{const response=await fetch('/api/state',{cache:'no-store'});const body=await response.json();if(!response.ok)throw new Error(body.error||'Dashboard request failed');render(body)}catch(error){const box=document.getElementById('error');box.textContent=error instanceof Error?error.message:String(error);box.classList.remove('hidden');document.getElementById('live-text').textContent='Disconnected'}}
refresh();setInterval(refresh,2000);
</script></body></html>`;
}

function openDashboard(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.on("error", () => {
		console.log(`Open ${url} in your browser.`);
	});
	child.unref();
}

export async function runAutoresearchDashboardCommand(args: string[]): Promise<void> {
	const options = parseAutoresearchDashboardArgs(args);
	const agentDir = getAgentDir();
	// Fail before opening a port when no matching state exists.
	const initial = loadDashboardPayload(agentDir, options.sessionId);
	const server = createServer((request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ error: "method not allowed" }));
			return;
		}
		if (request.url === "/api/state") {
			try {
				const payload = loadDashboardPayload(agentDir, options.sessionId);
				response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
				response.end(request.method === "HEAD" ? undefined : JSON.stringify(payload));
			} catch (error) {
				response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
				response.end(
					request.method === "HEAD"
						? undefined
						: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
				);
			}
			return;
		}
		if (request.url === "/" || request.url === "/index.html") {
			response.setHeader(
				"Content-Security-Policy",
				"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
			);
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(request.method === "HEAD" ? undefined : dashboardHtml());
			return;
		}
		response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		response.end(request.method === "HEAD" ? undefined : "Not found");
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(options.port, DASHBOARD_HOST, () => {
			server.off("error", onError);
			resolve();
		});
	});
	const url = `http://${DASHBOARD_HOST}:${options.port}/`;
	console.log(`Autoresearch dashboard: ${url}`);
	console.log(`Session: ${initial.sessionId} · current phase: ${initial.currentPhase.title}`);
	console.log("Press Ctrl+C to stop the local dashboard.");
	if (options.openBrowser) openDashboard(url);

	const stop = () => server.close();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await new Promise<void>((resolve) => server.once("close", resolve));
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}
