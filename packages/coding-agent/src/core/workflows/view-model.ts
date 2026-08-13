import type { ExtensionWorkflowPanelData } from "../extensions/types.js";
import type { WorkflowRunRecord } from "./storage.js";

export function toWorkflowPanelData(
	run: WorkflowRunRecord,
	actions: string[],
	agentDir?: string,
): ExtensionWorkflowPanelData {
	const agents = run.progress?.agents ?? [];
	return {
		cwd: run.cwd,
		...(agentDir ? { agentDir } : {}),
		runId: run.runId,
		workflowName: run.workflowName,
		...(run.description ? { description: run.description } : {}),
		status: run.status,
		startedAt: run.startedAt,
		...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
		agentCount: run.agentCount ?? agents.length,
		phases: getWorkflowPanelPhaseTitles(run).map((title) => ({
			title,
			agents: agents
				.filter((agent) => (agent.phase ?? "Unphased") === title)
				.map((agent) => ({
					id: agent.id,
					label: agent.label,
					status: agent.status,
					...(agent.phase ? { phase: agent.phase } : {}),
					...(agent.prompt ? { prompt: agent.prompt } : {}),
					...(agent.model ? { model: agent.model } : {}),
					...(agent.effort ? { effort: agent.effort } : {}),
					...(agent.startedAt ? { startedAt: agent.startedAt } : {}),
					...(agent.completedAt ? { completedAt: agent.completedAt } : {}),
					...(agent.usage ? { totalTokens: agent.usage.totalTokens, cost: agent.usage.cost } : {}),
					...(agent.error ? { error: agent.error } : {}),
					...(agent.resultPreview ? { resultPreview: agent.resultPreview } : {}),
				})),
		})),
		actions,
	};
}

function getWorkflowPanelPhaseTitles(run: WorkflowRunRecord): string[] {
	const titles = [...(run.phases ?? [])];
	for (const agent of run.progress?.agents ?? []) {
		const title = agent.phase ?? "Unphased";
		if (!titles.includes(title)) titles.push(title);
	}
	return titles;
}
