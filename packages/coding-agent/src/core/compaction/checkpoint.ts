import { isCompactionCheckpoint, type ProviderCompactionCheckpoint } from "@earendil-works/pi-ai";

export function hasProviderCheckpoint(details: unknown): boolean {
	return details !== null && typeof details === "object" && "providerCheckpoint" in details;
}

export function getProviderCheckpoint(details: unknown): ProviderCompactionCheckpoint | undefined {
	if (details === null || typeof details !== "object" || !("providerCheckpoint" in details)) return undefined;
	return isCompactionCheckpoint(details.providerCheckpoint) ? details.providerCheckpoint : undefined;
}
