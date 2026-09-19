/**
 * Optional Jev decision support for bounded agent decisions.
 *
 * Jev is used only for typed classification. Callers must keep the existing
 * behavior when the service is unavailable or confidence is insufficient.
 */

/** Skill metadata sent to Jev as a bounded choice. */
export interface JevSkill {
	name: string;
	description: string;
}

/** Selected skill and Jev confidence. */
export interface JevSelection {
	name: string;
	confidence: number;
}

/** LocalJev connection settings. */
export interface JevClientOptions {
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

interface ChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
}

interface JevResponse {
	answers: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChoiceAnswer(value: unknown): value is ChoiceAnswer {
	return (
		record(value) &&
		value.type === "choice" &&
		typeof value.choice === "string" &&
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= 0 &&
		value.confidence <= 1
	);
}

function parseResponse(value: unknown): JevResponse {
	if (!record(value) || !record(value.answers)) {
		throw new Error("Jev response must contain an answers object");
	}
	return { answers: value.answers };
}

/** Client for the LocalJev `/v1/systemone` endpoint. */
export class JevClient {
	private readonly baseUrl: string;
	private readonly apiKey?: string;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(options: JevClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8080").replace(/\/$/, "");
		this.apiKey = options.apiKey;
		this.model = options.model ?? "jev-latest";
		this.timeoutMs = options.timeoutMs ?? 1500;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	/** Classify a prompt against the supplied skill choices. */
	async decideSkill(prompt: string, skills: readonly JevSkill[]): Promise<JevSelection | undefined> {
		if (skills.length < 2 || skills.length > 128) return undefined;
		const criteria = Object.fromEntries(skills.map((skill) => [skill.name, skill.description]));
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: this.model,
					state: prompt,
					questions: {
						skill: {
							type: "choice",
							instructions: "Which one skill is most relevant to the user's request?",
							criteria,
						},
					},
				}),
				signal: controller.signal,
			});
			if (!response.ok) return undefined;
			const payload = parseResponse(await response.json());
			const answer = payload.answers.skill;
			if (!isChoiceAnswer(answer) || !criteria[answer.choice]) return undefined;
			return { name: answer.choice, confidence: answer.confidence };
		} catch {
			return undefined;
		} finally {
			clearTimeout(timeout);
		}
	}
}

/** Select a skill only when Jev returns enough confidence to act. */
export async function selectSkillWithJev(
	client: JevClient,
	prompt: string,
	skills: readonly JevSkill[],
	minimumConfidence: number,
): Promise<JevSelection | undefined> {
	const selection = await client.decideSkill(prompt, skills);
	return selection && selection.confidence >= minimumConfidence ? selection : undefined;
}

/** Keep only selected entries inside the model-facing available-skills block. */
export function filterSkillsInSystemPrompt(systemPrompt: string, selectedNames: readonly string[]): string {
	const selected = new Set(selectedNames);
	const blockPattern = /<available_skills>[\s\S]*?<\/available_skills>/;
	const block = systemPrompt.match(blockPattern)?.[0];
	if (!block) return systemPrompt;
	const entries = block.match(/\s*<skill>[\s\S]*?<\/skill>/g) ?? [];
	const kept = entries.filter((entry) => {
		const name = entry.match(/<name>([^<]+)<\/name>/)?.[1];
		return name !== undefined && selected.has(name);
	});
	if (kept.length === 0) return systemPrompt;
	const replacement = block
		.replace(/\s*<skill>[\s\S]*?<\/skill>/g, "")
		.replace("</available_skills>", `${kept.join("\n")}\n</available_skills>`);
	return systemPrompt.replace(blockPattern, replacement);
}
