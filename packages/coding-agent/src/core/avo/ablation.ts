export const AVO_ABLATION_FEATURES = [
	"obligations",
	"critical_assumptions",
	"qualified_watchdog",
	"adversarial_supervision",
	"impact_verification",
	"nooa",
] as const;

export type AvoAblationFeature = (typeof AVO_ABLATION_FEATURES)[number];

export const AVO_INTERNAL_ABLATIONS_ENV = "PRIME_AGENT_INTERNAL_AVO_ABLATIONS";

export function parseAvoAblations(value: string | undefined): Set<AvoAblationFeature> {
	const disabled = new Set<AvoAblationFeature>();
	for (const item of value?.split(",").map((entry) => entry.trim()) ?? []) {
		if (!item) continue;
		if (!(AVO_ABLATION_FEATURES as readonly string[]).includes(item)) {
			throw new Error(`unknown internal AVO ablation feature: ${item}`);
		}
		disabled.add(item as AvoAblationFeature);
	}
	return disabled;
}

export function activeAvoAblations(environment: NodeJS.ProcessEnv = process.env): Set<AvoAblationFeature> {
	return parseAvoAblations(environment[AVO_INTERNAL_ABLATIONS_ENV]);
}

export function isAvoFeatureAblated(
	feature: AvoAblationFeature,
	environment: NodeJS.ProcessEnv = process.env,
): boolean {
	return activeAvoAblations(environment).has(feature);
}
