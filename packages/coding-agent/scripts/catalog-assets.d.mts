export const MAX_REMOTE_CATALOG_BYTES: number;
export const bundledCatalogFiles: string[];

export interface CatalogAssetOptions {
	outDir?: string;
	catalogDir?: string;
	modelsUrl?: string;
	mcpServicesUrl?: string;
	fixture?: boolean;
	allowSmallFixture?: boolean;
	allowTokenForUrl?: boolean;
	optional?: boolean;
}

export interface CatalogAssetResult {
	skipped?: boolean;
	reason?: string;
	models?: { modelCount: number; transportTupleCount: number };
	mcpServices?: { serviceCount: number };
}

export function generateBundledCatalogAssets(options?: CatalogAssetOptions): Promise<CatalogAssetResult>;
export function copySourceCatalogAssets(options?: CatalogAssetOptions): Promise<CatalogAssetResult>;
export function validateBundledCatalogDir(directory: string, options?: CatalogAssetOptions): CatalogAssetResult;
